import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry } from "./schema.js";
import { packList, unpackList } from "./schema.js";
import { hashEntry } from "./ingest.js";
import { LegacyCatalog, lexicalMode, metaOf } from "./catalog.js";

function entry(p: Partial<MemoryEntry> & Pick<MemoryEntry, "id">): MemoryEntry {
  return {
    date: "2026-01-01", type: "note", title: p.id, people: [], teams: [], tags: [], body: `body of ${p.id}`,
    path: `/r/memory/entries/2026/01/${p.id}.md`, paths: { default: `/r/memory/entries/2026/01/${p.id}.md` }, graphs: ["default"],
    ...p,
  } as MemoryEntry;
}

const ENTRIES = [
  entry({ id: "a", people: ["ana"], tags: ["budget"], body: "alpha budget review" }),
  entry({ id: "b", date: "2026-02-01", type: "decision", people: ["boris"], follows: ["a"], body: "beta decision on budget" }),
  entry({ id: "c", date: "2026-03-01", type: "summary", sources: ["a"], source_ids: ["slack:C1:1.0"], body: "gamma rollup", graphs: ["default", "team-x"] }),
  entry({ id: "d", people: ["ana"], body: "delta unrelated note" }),
];

function catalog(dir: string): LegacyCatalog {
  return new LegacyCatalog("legacy", dir, { load: async () => ENTRIES, lexicalPath: join(dir, "lexical.json") });
}

test("packList/unpackList round-trip; empty ⇄ ''", () => {
  assert.equal(packList(["a", "b"]), "|a|b|");
  assert.equal(packList([]), "");
  assert.equal(packList(undefined), "");
  assert.deepEqual(unpackList("|a|b|"), ["a", "b"]);
  assert.deepEqual(unpackList(""), []);
});

test("lexicalMode: default postings, fts opt-in, anything else rejected", () => {
  // The default is the harness decision (docs/eval/fts-spike.md): FTS is
  // faster and better on MRR/nDCG@10, but its k1 flips a gated case.
  assert.equal(lexicalMode({}), "postings");
  assert.equal(lexicalMode({ MEMORY_LEXICAL: "fts" }), "fts");
  assert.equal(lexicalMode({ MEMORY_LEXICAL: "postings" }), "postings");
  assert.throws(() => lexicalMode({ MEMORY_LEXICAL: "bm25" }), /MEMORY_LEXICAL/);
});

test("LegacyCatalog: filter/byIds/linked/referrers/bySourceIds/count/all over the injected entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-cat-legacy-"));
  try {
    const c = catalog(dir);
    assert.equal(await c.count(), 4);
    assert.deepEqual((await c.filter({ person: "ana" })).map((m) => m.id), ["a", "d"]);
    assert.deepEqual((await c.filter({ graph: "team-x" })).map((m) => m.id), ["c"]);
    assert.deepEqual((await c.byIds(["c", "zzz", "a"])).map((m) => m.id), ["c", "a"]);
    assert.deepEqual((await c.byIds(["a", "a", "c"])).map((m) => m.id), ["a", "c"], "duplicates collapse to their first occurrence, in request order");
    assert.deepEqual((await c.linked()).map((m) => m.id).sort(), ["a", "b"]);
    assert.deepEqual((await c.referrers("a")).map((m) => m.id).sort(), ["b", "c"]);
    assert.deepEqual((await c.bySourceIds(["slack:C1:1.0"])).map((m) => m.id), ["c"]);
    assert.deepEqual((await c.bySourceIds([])).length, 0);
    assert.equal((await c.all()).length, 4);
    const meta = (await c.byIds(["a"]))[0]!;
    assert.equal(meta.hash, hashEntry(ENTRIES[0]!));
    assert.ok(!("body" in meta), "metas never carry bodies");
    assert.deepEqual(metaOf(ENTRIES[2]!).sources, ["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LegacyCatalog: hydrate returns the SAME entry objects (hash memo intact) and lexical is today's full BM25 list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-cat-legacy-"));
  try {
    const c = catalog(dir);
    const metas = await c.byIds(["b", "a"]);
    const hydrated = await c.hydrate(metas);
    assert.equal(hydrated[0], ENTRIES[1], "identity preserved");
    assert.equal(hydrated[1], ENTRIES[0]);
    const hits = await c.lexical("budget", new Set(["a", "b", "c", "d"]), 1);
    assert.deepEqual(hits.map((h) => h.id), ["a", "b"], "full list despite limit 1: today's lexical leg is never truncated");
    assert.ok(hits[0]!.score > hits[1]!.score, "sorted best first");
    assert.deepEqual((await c.lexical("budget", new Set(["a"]), 10)).map((h) => h.id), ["a"], "restricted to allowed ids");
    assert.deepEqual(await c.refresh(), { refreshed: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
