import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import * as lancedb from "@lancedb/lancedb";
import { generateCorpus } from "./eval-corpus.js";
import { hashEntry, parseEntry, groupEntries } from "./ingest.js";
import type { MemoryEntry } from "./schema.js";
import type { SearchFilters } from "./ranking.js";
import { LegacyCatalog, type Catalog } from "./catalog.js";
import { LanceCatalog } from "./catalog-lance.js";
import { ensureCatalogIndices, likeLiteral, syncCatalogTables, writeManifest, manifestFor, scanDirMtimes } from "./catalog-sync.js";

/**
 * Shadow mode (spec Phase 3 item 1): before any caller switches, the two
 * adapters must agree on every read over the same corpus — filtered sets,
 * chain-index input, source-id lookups, hydration, and the lexical leg
 * (identical lists under `postings`; rank agreement under `fts`, whose only
 * documented difference is Lance's k1 = 1.2 vs our 1.5 and tie order).
 */

/** Four source ids so bySourceIds has something to find (incl. LIKE metacharacters). */
const SOURCE_IDS = ["slack:C1:1700000000.1", "gmail:thread_1", "gmail:100%", "gcal:ev-1"];

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function kendallTauB(a: number[], b: number[]): number {
  let c = 0, d = 0, ta = 0, tb = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const da = Math.sign(a[i]! - a[j]!);
      const db = Math.sign(b[i]! - b[j]!);
      if (da === 0 && db === 0) continue;
      if (da === 0) ta++;
      else if (db === 0) tb++;
      else if (da === db) c++;
      else d++;
    }
  }
  const denom = Math.sqrt((c + d + ta) * (c + d + tb));
  return denom === 0 ? 1 : (c - d) / denom;
}

/**
 * The corpus is the source of truth for BOTH adapters, so the source ids are
 * written into the Markdown rather than patched onto the in-memory entries:
 * `LanceCatalog.hydrate` re-reads the file, and the test asserts the hydrated
 * entry still hashes to the stored hash.
 */
async function loadCorpus(root: string): Promise<{ entries: MemoryEntry[]; queries: string[] }> {
  const manifest = await generateCorpus({ root, total: 300, seed: 7, families: ["needle", "chain", "filter", "title"] });
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".md")) files.push(p);
    }
  };
  walk(join(root, "memory", "entries"));
  files.sort();
  for (const [i, sid] of SOURCE_IDS.entries()) {
    const path = files[i]!;
    const { data, content } = matter(readFileSync(path, "utf8"));
    writeFileSync(path, matter.stringify(content, { ...data, source_ids: [sid] }), "utf8");
  }
  const parsed = await Promise.all(files.map(parseEntry));
  const entries = groupEntries(parsed, "throw").entries;
  return { entries, queries: manifest.cases.map((c) => c.query) };
}

async function buildLance(entries: MemoryEntry[], root: string, dir: string, mode: "postings" | "fts"): Promise<LanceCatalog> {
  const db = await lancedb.connect(dir);
  await syncCatalogTables(db, entries, { root });
  await ensureCatalogIndices(db);
  const stores = [{ entriesDir: join(root, "memory", "entries"), summariesDir: join(root, "memory", "summaries") }];
  await writeManifest(dir, await manifestFor(db, await scanDirMtimes(stores, root), null));
  return LanceCatalog.open({ slot: "next", dir, root, mode, autoRefresh: false });
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

test("shadow mode: LanceCatalog == LegacyCatalog on a 300-entry synthetic corpus", { timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-shadow-")));
  try {
    const { entries, queries } = await loadCorpus(root);
    const legacy: Catalog = new LegacyCatalog("legacy", join(root, ".index"), { load: async () => entries, lexicalPath: join(root, ".index", "lexical.json") });
    const lance = await buildLance(entries, root, join(root, ".index", "slots", "next"), "postings");

    assert.equal(await lance.count(), await legacy.count());
    assert.deepEqual(ids(await lance.all()), ids(await legacy.all()));

    // filters: 150 random draws, same shape as src/store-filters.test.ts
    const rand = mulberry32(11);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const people = [...new Set(entries.flatMap((e) => e.people))];
    const tags = [...new Set(entries.flatMap((e) => e.tags))];
    const types = [...new Set(entries.map((e) => e.type))];
    for (let i = 0; i < 150; i++) {
      const f: SearchFilters = {};
      if (rand() < 0.5) f.person = pick(people);
      if (rand() < 0.4) f.tag = pick(tags);
      if (rand() < 0.3) f.type = pick(types);
      if (rand() < 0.4) f.since = pick(["2024-01-01", "2025-06-01"]);
      if (rand() < 0.3) f.until = pick(["2025-01-01", "2026-03-01"]);
      assert.deepEqual(ids(await lance.filter(f)), ids(await legacy.filter(f)), `filter ${JSON.stringify(f)}`);
    }

    // metas are field-identical, in REQUEST order (the documented byIds contract)
    const sample = entries.slice(0, 20).map((e) => e.id);
    assert.deepEqual(await lance.byIds(sample), await legacy.byIds(sample));
    const shuffled = [sample[7]!, sample[0]!, sample[7]!, "no-such-entry", sample[3]!];
    assert.deepEqual(
      (await lance.byIds(shuffled)).map((m) => m.id),
      [sample[7]!, sample[0]!, sample[3]!],
      "byIds keeps request order, collapses duplicates, skips unknown ids",
    );
    assert.deepEqual(await lance.byIds(shuffled), await legacy.byIds(shuffled));

    // chain-index input and referrers
    const linkedL = await lance.linked();
    const linkedG = await legacy.linked();
    assert.ok(linkedG.length > 0, "corpus has follows chains");
    assert.deepEqual(linkedL.sort((a, b) => a.id.localeCompare(b.id)), linkedG.sort((a, b) => a.id.localeCompare(b.id)));
    const target = linkedG.find((e) => e.follows?.length)!.follows![0]!;
    assert.deepEqual(ids(await lance.referrers(target)), ids(await legacy.referrers(target)));

    // source ids (including LIKE metacharacters)
    for (const sid of [...SOURCE_IDS, "gmail:thread-1", "nope:x"]) {
      assert.deepEqual(ids(await lance.bySourceIds([sid])), ids(await legacy.bySourceIds([sid])), sid);
    }
    assert.equal((await lance.bySourceIds(["gmail:100%"])).length, 1, "a LIKE metacharacter in a source id still matches exactly one entry");
    assert.equal((await lance.bySourceIds(["gmail:thread-1"])).length, 0, "the SQL superset match is re-checked in JS");

    // hydration: same MemoryEntry fields and the same content hash
    const metas = await lance.byIds(sample.slice(0, 5));
    const hydratedL = await lance.hydrate(metas);
    const hydratedG = await legacy.hydrate(metas);
    for (let i = 0; i < metas.length; i++) {
      assert.deepEqual({ ...hydratedL[i] }, { ...hydratedG[i] });
      assert.equal(hashEntry(hydratedL[i]!), metas[i]!.hash);
    }

    // lexical leg, postings mode: identical ranked lists (ids AND scores)
    const allowed = new Set(entries.map((e) => e.id));
    for (const q of queries.slice(0, 60)) {
      const a = await lance.lexical(q, allowed, 40);
      const b = await legacy.lexical(q, allowed, 40);
      assert.deepEqual(a, b, `postings lexical for "${q}"`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shadow mode, fts: Lance full-text ranking agrees with bm25Scores up to the documented k1 difference", { timeout: 120_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-shadow-fts-")));
  try {
    const { entries, queries } = await loadCorpus(root);
    const legacy = new LegacyCatalog("legacy", join(root, ".index"), { load: async () => entries, lexicalPath: join(root, ".index", "lexical.json") });
    const lance = await buildLance(entries, root, join(root, ".index", "slots", "next"), "fts");
    const allowed = new Set(entries.map((e) => e.id));
    const taus: number[] = [];
    const overlaps: number[] = [];
    let top1 = 0;
    let top1Near = 0;
    let compared = 0;
    /** The k1 difference only ever reorders near-tied documents: 1% of the reference's best score. */
    const NEAR_TIE = 0.01;
    for (const q of queries.slice(0, 80)) {
      const fts = await lance.lexical(q, allowed, 40);
      const ref = await legacy.lexical(q, allowed, 40);
      if (fts.length < 2 || ref.length === 0) continue;
      compared++;
      assert.ok(fts.length <= 40, "fts honours the limit");
      const refScore = new Map(ref.map((h) => [h.id, h.score]));
      taus.push(kendallTauB(fts.map((h) => refScore.get(h.id) ?? 0), fts.map((h) => h.score)));
      const refTop = ref.slice(0, 40);
      const ftsIds = new Set(fts.map((h) => h.id));
      overlaps.push(refTop.filter((h) => ftsIds.has(h.id)).length / Math.max(refTop.length, fts.length));
      const refMax = ref[0]!.score;
      const refTops = new Set(ref.filter((h) => h.score === refMax).map((h) => h.id));
      if (refTops.has(fts[0]!.id)) top1++;
      if ((refScore.get(fts[0]!.id) ?? 0) >= refMax * (1 - NEAR_TIE)) top1Near++;
    }
    assert.ok(compared >= 40, `compared ${compared} phrasings`);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const meanTau = mean(taus);
    console.log(
      `  fts vs postings over ${compared} phrasings: mean tau ${meanTau.toFixed(3)} · top-40 overlap ${(mean(overlaps) * 100).toFixed(1)}% · top-1 exact ${top1}/${compared} · top-1 within 1% ${top1Near}/${compared}`,
    );
    assert.ok(meanTau >= 0.9, `mean Kendall tau ${meanTau.toFixed(3)} (spike: 0.98)`);
    /**
     * The binding guarantee: FTS never promotes a materially worse document to
     * rank 1. Exact top-1 is the weaker floor — the k1 difference flips pairs
     * whose reference scores sit within ~0.2% of each other (the chain fixtures
     * note/decision pairs), which is the documented, accepted divergence.
     */
    assert.ok(top1Near / compared >= 0.95, `top-1 within ${NEAR_TIE * 100}% of the best reference score: ${top1Near}/${compared}`);
    assert.ok(top1 / compared >= 0.9, `exact top-1 agreement ${top1}/${compared}`);

    // filtered FTS returns filtered rows only (spike gate 1)
    const decisions = new Set((await legacy.filter({ type: "decision" })).map((m) => m.id));
    const decisionHits = await lance.lexical(queries[0]!, decisions, 40, { type: "decision" });
    assert.ok(decisionHits.every((h) => decisions.has(h.id)), "every FTS hit is inside the filter");

    /**
     * …and the limit applies INSIDE the filtered space. Without the SQL
     * prefilter, `limit` is spent on rows the `allowed` set then throws away,
     * so a narrow filter over a common phrasing silently loses hits the
     * postings leg keeps. `widened` proves at least one draw depends on it.
     */
    const rand = mulberry32(23);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const people = [...new Set(entries.flatMap((e) => e.people))];
    const types = [...new Set(entries.map((e) => e.type))];
    const phrasings = queries.slice(0, 80);
    let draws = 0;
    let widened = 0;
    for (let i = 0; i < 40; i++) {
      const f: SearchFilters = rand() < 0.5 ? { person: pick(people) } : { type: pick(types) };
      const scoped = new Set((await legacy.filter(f)).map((m) => m.id));
      if (scoped.size === 0) continue;
      const q = pick(phrasings);
      const ref = await legacy.lexical(q, scoped, 40);
      const hits = await lance.lexical(q, scoped, 40, f);
      if (ref.length === 0) continue;
      draws++;
      assert.ok(hits.every((h) => scoped.has(h.id)), `every hit inside ${JSON.stringify(f)}`);
      assert.ok(
        hits.length >= Math.min(40, ref.length),
        `filtered fts returned ${hits.length}, postings ${ref.length} for ${JSON.stringify(f)} / "${q}"`,
      );
      if ((await lance.lexical(q, scoped, 40)).length < hits.length) widened++;
    }
    console.log(`  filtered fts: ${draws} draws at parity with the postings leg · ${widened} recovered hits post-filtering alone would have lost`);
    assert.ok(draws >= 20, `exercised ${draws} filtered draws`);
    assert.ok(widened > 0, `${widened} draws recovered hits that post-filtering alone would have lost`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("likeLiteral: quotes doubled, LIKE metacharacters widened to a single-char wildcard", () => {
  assert.equal(likeLiteral("it's"), "it''s");
  assert.equal(likeLiteral("100%_x"), "100__x");
});
