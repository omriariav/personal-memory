import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainAncestry } from "./chains.js";
import { REPO, STORE_MOD, runInStore, seedStore, type SeedEntry } from "./test-store.js";

const MEMBERSHIP = JSON.stringify(join(REPO, "src", "membership.ts"));
const GM = JSON.stringify(join(REPO, "src", "graph-maintenance.ts"));
const BUILD = JSON.stringify(join(REPO, "src", "slot-build.ts"));

/** `.index/slots/main/meta.json` — present exactly when the implicit fresh slot has been built. */
function freshSlotMeta(root: string): string {
  return join(root, ".index", "slots", "main", "meta.json");
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** The CLI reports a failure as `✗ <message>` on stderr with a non-zero exit. */
function cliStderr(cwd: string, args: string[], env: Record<string, string> = {}): string {
  try {
    cli(cwd, args, env);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? "");
  }
}

test("chainAncestry: walks follows transitively through the lookup, cycle-safe", async () => {
  const graph: Record<string, string[]> = { d: ["c"], c: ["b", "x"], b: ["a"], a: [], x: ["c"] };
  const lookup = async (ids: string[]) =>
    ids.filter((id) => id in graph).map((id) => ({ id, date: "2026-01-01", follows: graph[id] }));
  const got = await chainAncestry(lookup, ["d"]);
  assert.deepEqual(got.map((e) => e.id).sort(), ["a", "b", "c", "d", "x"], "every ancestor reached exactly once");
});

test("on a store whose index was never built: a read refuses, a writer builds the slot and proceeds", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-membership-unbuilt-")));
  try {
    seedStore(root);
    assert.equal(existsSync(freshSlotMeta(root)), false, "the store starts with no index at all");
    assert.match(cliStderr(root, ["list"]), /no index built for slot/, "a read never materializes a slot");
    assert.equal(existsSync(freshSlotMeta(root)), false, "and the refused read left nothing behind");

    const r = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       const g = await import(${GM});
       const copy = await m.copyEntry({ id: "2026-01-03-otter-hiring", to: "team-x" });
       const link = await g.applyChainLink({ laterId: "2026-01-06-rare-codeword", follows: ["2026-01-03-otter-hiring"], refreshAudit: false });
       const removeBlocked = await m.removeEntry("2026-01-02-quokka-budget");
       const merge = await g.mergeSlugs({ kind: "person", from: "chen-mizrahi", to: "chen-m", createTarget: true, refreshAudit: false });
       console.log(JSON.stringify({ copy, link, removeBlocked, merge }));`,
    ) as Record<string, any>;
    assert.equal(r.copy.changed, true, "copyEntry works with no pre-built index");
    assert.equal(r.link.changed, true, "applyChainLink works with no pre-built index");
    assert.deepEqual(r.removeBlocked.blockedBy, ["summary-tag-budget"], "removeEntry works with no pre-built index");
    assert.equal(r.merge.affectedEntries, 1, "mergeSlugs works with no pre-built index");
    assert.ok(existsSync(freshSlotMeta(root)), "the writers built the active slot on the way through");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("add works on a store whose index was never built, and leaves the active slot built", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-add-unbuilt-")));
  try {
    seedStore(root);
    assert.equal(existsSync(freshSlotMeta(root)), false, "the store starts with no index at all");
    const out = cli(root, ["add", "--title", "Narwhal retro", "--type", "note", "--body", "A fresh capture on an index-less store.", "--force-new"]);
    assert.match(out, /✓ created \d{4}-\d{2}-\d{2}-narwhal-retro/, "the capture succeeded");
    assert.ok(existsSync(freshSlotMeta(root)), "the capture built the active slot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** One entry with two referrers whose id order is the reverse of their dates. */
const TWO_REFERRERS: SeedEntry[] = [
  { id: "2026-02-01-kelp-rollout", date: "2026-02-01", type: "note", title: "Kelp rollout", body: "The kelp rollout plan and its open questions." },
  { id: "summary-zebra", date: "2026-02-02", type: "summary", title: "Rolling summary — zebra", sources: ["2026-02-01-kelp-rollout"], body: "## Synthesis\n\nZebra view of the kelp rollout." },
  { id: "summary-aardvark", date: "2026-02-03", type: "summary", title: "Rolling summary — aardvark", sources: ["2026-02-01-kelp-rollout"], body: "## Synthesis\n\nAardvark view of the kelp rollout." },
];

/**
 * A fresh build inserts the catalog's rows in corpus order, so both formats
 * agree by accident. They diverge once an entry is edited: the incremental
 * sync deletes and re-adds that row, which moves it to the END of the Lance
 * table while the legacy corpus order is unchanged. That is the state this
 * test puts the store in before comparing.
 */
test("id lists are sorted, so the legacy and new-format slots report the same blockedBy after an edit", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-membership-order-")));
  try {
    seedStore(root, TWO_REFERRERS);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex(); console.log("null");`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD}); await b.buildSlot({ name: "next" }); console.log("null");`, { MEMORY_INDEX_SLOT: "legacy" });

    const edited = join(root, "memory", "summaries", "summary-aardvark.md");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}\nOne more line, so this entry's row is rewritten.\n`, "utf8");
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex(); console.log("null");`, { MEMORY_INDEX_SLOT: "legacy" });

    const blockedOn = (slot: string) =>
      (
        runInStore(
          root,
          `const m = await import(${MEMBERSHIP});
           console.log(JSON.stringify(await m.removeEntry("2026-02-01-kelp-rollout")));`,
          { MEMORY_INDEX_SLOT: slot },
        ) as { blockedBy?: string[] }
      ).blockedBy;

    assert.deepEqual(blockedOn("legacy"), ["summary-aardvark", "summary-zebra"], "legacy slot reports id order");
    assert.deepEqual(blockedOn("next"), ["summary-aardvark", "summary-zebra"], "new-format slot reports the same order");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy/move/remove/link and slug merge work on a format-2 active slot (reads via the catalog, writes keep every slot in sync)", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-membership-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex(); console.log("null");`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD}); await b.buildSlot({ name: "next" }); await b.activateSlot("next"); console.log("null");`);
    const r = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       const g = await import(${GM});
       const copy = await m.copyEntry({ id: "2026-01-03-otter-hiring", to: "team-x" });
       const blocked = await m.copyEntry({ id: "2026-01-05-budget-decided", to: "team-x" });
       const link = await g.applyChainLink({ laterId: "2026-01-06-rare-codeword", follows: ["2026-01-03-otter-hiring"], refreshAudit: false });
       const removeBlocked = await m.removeEntry("2026-01-02-quokka-budget");
       const merge = await g.mergeSlugs({ kind: "person", from: "chen-mizrahi", to: "chen-m", createTarget: true, refreshAudit: false });
       const moved = await m.moveEntry({ id: "2026-01-03-otter-hiring", to: "default" });
       console.log(JSON.stringify({ copy, blocked, link, removeBlocked, merge, moved }));`,
    ) as Record<string, any>;
    assert.equal(r.copy.changed, true, "copy into team-x succeeded");
    assert.deepEqual(r.copy.index.slots.map((s: { slot: string }) => s.slot).sort(), ["legacy", "next"], "writers sync both slots");
    assert.deepEqual(r.blocked.blockedBy, ["2026-01-04-budget-pending"], "containment via catalog byIds");
    assert.equal(r.link.changed, true, "chain link written");
    assert.deepEqual(r.removeBlocked.blockedBy, ["summary-tag-budget"], "referrers via catalog");
    assert.equal(r.merge.affectedEntries, 1, "one entry carried the merged person slug");
    assert.equal(r.moved.changed, true, "move back to default succeeded");
    assert.equal(
      existsSync(join(root, "memory-graphs", "team-x", "entries", "2026", "01", "2026-01-03-otter-hiring.md")),
      false,
      "moved back out of team-x",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
