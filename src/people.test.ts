import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAliasIndex,
  detectPeople,
  humanize,
  loadPeopleProfiles,
  normalizeName,
  resolvePerson,
  writePeopleProfile,
  type PersonProfile,
} from "./people.js";

const profiles: PersonProfile[] = [
  { slug: "evgenia-ivanova", display_name: "Evgenia Ivanova", aliases: ["Zhenya"] },
  { slug: "alexander-petrov", aliases: ["Sasha", "Alex P"] },
  { slug: "alexandra-smirnova", aliases: ["Sasha"] },
  { slug: "jane-doe-smith", aliases: ["Jane Doe Smith"] },
];
const known = ["jane-doe", "boris-levi", ...profiles.map((p) => p.slug)];

test("normalizeName: lowercase, diacritics stripped, punctuation to single spaces", () => {
  assert.equal(normalizeName("  Jane   Doe! "), "jane doe");
  assert.equal(normalizeName("Ćéline O'Brien"), "celine o brien");
  assert.equal(normalizeName("J.D."), "j d");
  assert.equal(humanize("jane-doe"), "jane doe");
});

test("buildAliasIndex: every known slug gets itself and its humanized form; profile aliases map to their slug; shared aliases are ambiguous", () => {
  const idx = buildAliasIndex(profiles, known);
  assert.deepEqual([...idx.byName.get("jane doe")!], ["jane-doe"]); // the raw slug normalizes to the same key
  assert.equal(idx.byName.has("jane-doe"), false);
  assert.deepEqual([...idx.byName.get("zhenya")!], ["evgenia-ivanova"]);
  assert.deepEqual([...idx.byName.get("evgenia ivanova")!], ["evgenia-ivanova"]);
  assert.deepEqual([...idx.byName.get("alex p")!], ["alexander-petrov"]);
  assert.deepEqual([...idx.byName.get("sasha")!].sort(), ["alexander-petrov", "alexandra-smirnova"]);
  assert.equal(idx.maxWords, 3);
});

test("detectPeople: sliding window, longest match first, ambiguous aliases reported but not resolved", () => {
  const idx = buildAliasIndex(profiles, known);
  const d = detectPeople("What did Zhenya decide with Jane Doe about the rollout?", idx);
  assert.deepEqual(d.slugs, ["evgenia-ivanova", "jane-doe"]);
  assert.deepEqual(d.matched, { zhenya: ["evgenia-ivanova"], "jane doe": ["jane-doe"] });
  assert.deepEqual(d.ambiguous, []);

  const longest = detectPeople("ask jane doe smith", idx);
  assert.deepEqual(longest.slugs, ["jane-doe-smith"]);

  const amb = detectPeople("Sasha owns the gateway", idx);
  assert.deepEqual(amb.slugs, []);
  assert.deepEqual(amb.ambiguous, ["sasha"]);

  assert.deepEqual(detectPeople("nothing to see here", idx).slugs, []);
  assert.deepEqual(detectPeople("boris-levi and boris levi", idx).slugs, ["boris-levi"]);
});

test("profiles: write/load round-trip, filename must equal slug, invalid frontmatter is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-people-"));
  try {
    const path = await writePeopleProfile({ slug: "evgenia-ivanova", display_name: "Evgenia Ivanova", aliases: ["Zhenya", "Zhenya"] }, dir);
    assert.equal(path, join(dir, "evgenia-ivanova.md"));
    const loaded = await loadPeopleProfiles(dir);
    assert.deepEqual(loaded, [{ slug: "evgenia-ivanova", display_name: "Evgenia Ivanova", aliases: ["Zhenya"] }]);

    writeFileSync(join(dir, "wrong-name.md"), "---\nslug: someone-else\naliases: []\n---\n");
    await assert.rejects(loadPeopleProfiles(dir), /wrong-name\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPeopleProfiles: a missing directory means no profiles", async () => {
  assert.deepEqual(await loadPeopleProfiles(join(tmpdir(), "pm-people-does-not-exist")), []);
});

test("resolvePerson: exact slug, alias, fuzzy slug, ambiguous, unknown", () => {
  const idx = buildAliasIndex(profiles, known);
  assert.deepEqual(resolvePerson("jane-doe", idx), { slug: "jane-doe", via: "slug" });
  assert.deepEqual(resolvePerson("Zhenya", idx), { slug: "evgenia-ivanova", via: "alias" });
  assert.deepEqual(resolvePerson("Evgenia Ivanova", idx), { slug: "evgenia-ivanova", via: "alias" });
  assert.deepEqual(resolvePerson("jane-do", idx), { slug: "jane-doe", via: "fuzzy" });
  assert.deepEqual(resolvePerson("Sasha", idx), { ambiguous: ["alexander-petrov", "alexandra-smirnova"] });
  assert.equal(resolvePerson("zzzz", idx), null);
});

test("detectPeople: `aliased` lists only slugs reached through a real alias or display name, never a typed slug or its humanized form", () => {
  const idx = buildAliasIndex(profiles, known);
  const d = detectPeople("Zhenya met jane-doe and Jane Doe about evgenia ivanova's plan", idx);
  assert.deepEqual(d.slugs, ["evgenia-ivanova", "jane-doe"]);
  assert.deepEqual(d.aliased, ["evgenia-ivanova"]);
  assert.deepEqual(detectPeople("call Evgenia Ivanova", idx).aliased, [], "equals the humanized slug: lexical already matches");
  assert.deepEqual(detectPeople("call Alex P", idx).aliased, ["alexander-petrov"]);
  assert.deepEqual(detectPeople("ping alexander-petrov", idx).aliased, []);
});
