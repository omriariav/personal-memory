import { test } from "node:test";
import assert from "node:assert/strict";
import { groupEntries, hashBody, hashEntry, type FileEntry } from "./ingest.js";

/**
 * Declared variants: a shared-graph copy whose body was deliberately replaced
 * by a user-approved redaction. The whole point is that `groupEntries` can
 * tell one from drift — it throws on drift, and it is on the load path of
 * every command, so getting this wrong makes the store unreadable.
 */

const HOME_BODY = "Dana raised that Q4 scope is unrealistic, and asked about the band-6 bump.";
const REDACTED = "Dana flagged the Q4 scope as unrealistic and asked for it to be re-cut.";

function file(
  partial: Partial<FileEntry> & Pick<FileEntry, "id" | "graph" | "hash">,
): FileEntry {
  return {
    date: "2026-01-01",
    type: "note",
    title: partial.id,
    people: [],
    teams: [],
    tags: [],
    body: HOME_BODY,
    path: `/repo/${partial.graph === "default" ? "memory" : `memory-graphs/${partial.graph}`}/entries/2026/01/${partial.id}.md`,
    ...partial,
  } as FileEntry;
}

/** A home + a shared copy carrying a redacted body, declared against `declared`. */
function pair(declared: string) {
  return [
    file({ id: "a", graph: "default", hash: "h-home" }),
    file({
      id: "a",
      graph: "team-x",
      hash: "h-variant",
      body: REDACTED,
      variant_of_hash: declared,
    }),
  ];
}

test("a copy declaring variant_of_hash is not drift", () => {
  const { entries, drift, staleVariants, variantViolations } = groupEntries(
    pair(hashBody(HOME_BODY)),
  );
  assert.deepEqual(drift, []);
  assert.deepEqual(staleVariants, []);
  assert.deepEqual(variantViolations, []);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]!.graphs, ["default", "team-x"]);
  assert.deepEqual(entries[0]!.variants, { "team-x": hashBody(HOME_BODY) });
});

test("the logical entry keeps the home's body and hash, not the variant's", () => {
  // This is what protects the index and every dismissal keyed on the hash:
  // publishing a redaction is a membership event, not a content change.
  const { entries } = groupEntries(pair(hashBody(HOME_BODY)));
  assert.equal(entries[0]!.body, HOME_BODY);
  assert.equal(hashEntry(entries[0]!), "h-home");
  assert.match(entries[0]!.path, /\/memory\/entries\//);
});

test("a variant whose home body changed is reported stale, never thrown", () => {
  const { entries, drift, staleVariants } = groupEntries(pair(hashBody("what it used to say")));
  assert.deepEqual(drift, []);
  assert.equal(entries.length, 1, "the entry still loads — the published copy is valid, just behind");
  assert.equal(staleVariants.length, 1);
  assert.equal(staleVariants[0]!.graph, "team-x");
  assert.equal(staleVariants[0]!.declared, hashBody("what it used to say"));
  assert.equal(staleVariants[0]!.home, hashBody(HOME_BODY));
});

test("a frontmatter-only change does not make a variant stale", () => {
  // A tag merge or a new chain link bumps frontmatter across every copy. If
  // variant_of_hash covered the whole entry, one slug merge would re-queue
  // every variant in the store.
  const files = pair(hashBody(HOME_BODY));
  files[0]!.tags = ["kubernetes"];
  files[1]!.tags = ["kubernetes"];
  const { staleVariants } = groupEntries(files);
  assert.deepEqual(staleVariants, []);
});

test("variant_of_hash on the home is a violation, and the copy still faces the drift check", () => {
  const files = [
    file({ id: "a", graph: "default", hash: "h1", variant_of_hash: hashBody(HOME_BODY) }),
    file({ id: "a", graph: "team-x", hash: "h2", body: REDACTED }),
  ];
  // Demoted to a plain copy, so the real mismatch is not hidden behind the field.
  assert.throws(() => groupEntries(files), /drifted apart/);
  const { variantViolations } = groupEntries(files, "collect");
  assert.equal(variantViolations.length, 1);
  assert.equal(variantViolations[0]!.reason, "home-declares-variant");
});

test("a variant with no private home is a violation, not an accepted divergence", () => {
  const files = [
    file({ id: "a", graph: "team-x", hash: "h1", body: REDACTED, variant_of_hash: hashBody(HOME_BODY) }),
    file({ id: "a", graph: "team-y", hash: "h2" }),
  ];
  const { variantViolations, drift } = groupEntries(files, "collect");
  assert.equal(variantViolations.length, 1);
  assert.equal(variantViolations[0]!.reason, "no-home");
  assert.equal(drift.length, 1, "with nothing to diverge from, the copies are simply drifted");
});

test("an undeclared differing copy is still drift", () => {
  const files = [
    file({ id: "a", graph: "default", hash: "h1" }),
    file({ id: "a", graph: "team-x", hash: "h2", body: REDACTED }),
  ];
  assert.throws(() => groupEntries(files), /drifted apart[\s\S]*graphs sync/);
});

test("drift in the plain copies still throws even when a valid variant exists", () => {
  const files = [
    ...pair(hashBody(HOME_BODY)),
    file({ id: "a", graph: "team-y", hash: "h-drifted", body: "something else entirely" }),
  ];
  assert.throws(() => groupEntries(files), /drifted apart/);
});

test("hashBody ignores surrounding whitespace but not the words", () => {
  assert.equal(hashBody(`\n${HOME_BODY}\n`), hashBody(HOME_BODY));
  assert.notEqual(hashBody(REDACTED), hashBody(HOME_BODY));
});
