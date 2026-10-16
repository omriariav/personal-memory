#!/usr/bin/env -S npx tsx
/**
 * Phase 3 spike: can LanceDB full-text search replace the JSON postings
 * lexical index (`.index/lexical.json`)? Runs the four gates from the plan on a
 * synthetic corpus and prints one verdict per gate. Text only — no embedding
 * model, no vectors; the FTS table lives in a scratch dir beside the corpus
 * and never touches the corpus' `.index/`.
 *
 *   npx tsx scripts/spike-fts.ts [--size 4000] [--seed 42] [--pool 40] [--queries 400]
 *       [--lancedb <path to an alternative @lancedb/lancedb dist/index.js>]
 *
 * Gates:
 *   (1) filter + FTS returns filtered rows only (JS `matchesFilters` is the authority)
 *   (2) rows added after the index was built are still found before `optimize()`
 *   (3) Kendall τ-b ≥ 0.95 between FTS scores and `bm25Scores` over the FTS top-<pool>
 *       ids, per eval phrasing (plus top-<pool> set overlap and top-1 agreement)
 *   (4) p50 < 40 ms per phrasing (target corpus: 100k entries)
 */
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GEN_VERSION, generateCorpus, type CorpusManifest } from "../src/eval-corpus.js";
import type { SearchFilters } from "../src/ranking.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    size: { type: "string", default: "4000" },
    seed: { type: "string", default: "42" },
    pool: { type: "string", default: "40" },
    queries: { type: "string", default: "400" },
    lancedb: { type: "string" },
    worst: { type: "string", default: "0" },
  },
});
const lancedb: typeof import("@lancedb/lancedb") = values.lancedb ? await import(values.lancedb) : await import("@lancedb/lancedb");
const lancedbVersion = (() => {
  try {
    const pkg = values.lancedb ? join(dirname(dirname(values.lancedb)), "package.json") : join(dirname(dirname(fileURLToPath(import.meta.url))), "node_modules", "@lancedb", "lancedb", "package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
})();
console.error(`lancedb: ${lancedbVersion}${values.lancedb ? ` (${values.lancedb})` : ""}`);
const size = Number(values.size);
const seed = Number(values.seed);
const pool = Number(values.pool);
const maxQueries = Number(values.queries);

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const evalCache = join(repoRoot, ".cache", "eval");
const corpusDir = join(evalCache, `corpus-${size}-s${seed}`);
mkdirSync(corpusDir, { recursive: true });
const manifestPath = join(corpusDir, "eval-cases.json");
let manifest: CorpusManifest | null = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest)
  : null;
if (!manifest || manifest.generator !== GEN_VERSION) {
  console.error(`corpus: generating ${size} entries (seed ${seed}) under ${corpusDir} …`);
  manifest = await generateCorpus({ root: corpusDir, total: size, seed });
}
console.error(`corpus: ${manifest.entries} entries, ${manifest.cases.length} cases`);

// The engine roots itself at process.cwd() at module load — enter the corpus first.
process.chdir(corpusDir);
const ingest = await import("../src/ingest.js");
if (!ingest.INDEX_DIR.startsWith(corpusDir)) throw new Error(`engine rooted at ${ingest.INDEX_DIR}`);
const { entrySearchText, loadAllEntries } = ingest;
const { buildLexical, bm25Scores, tokenize } = await import("../src/lexical.js");
const { applyFilters, matchesFilters, whereClause } = await import("../src/ranking.js");
const { buildRecallQueries } = await import("../src/recall-queries.js");
const { packSlugs } = await import("../src/schema.js");

const ms = (t: number) => `${t.toFixed(1)} ms`;
const t0 = performance.now();
const entries = await loadAllEntries();
console.error(`load: ${entries.length} entries in ${ms(performance.now() - t0)}`);

interface LexRow extends Record<string, unknown> {
  id: string;
  date: string;
  type: string;
  people: string;
  teams: string;
  tags: string;
  graphs: string;
  lex: string;
}
function rowFor(e: (typeof entries)[number]): LexRow {
  return {
    id: e.id,
    date: e.date,
    type: e.type,
    people: packSlugs(e.people),
    teams: packSlugs(e.teams),
    tags: packSlugs(e.tags),
    graphs: packSlugs(e.graphs),
    lex: tokenize(entrySearchText(e)).join(" "),
  };
}

// --- build: index all but a holdback, then append the holdback (gate 2) ------
const HOLDBACK = Math.min(100, Math.floor(entries.length / 10));
const spikeDir = join(corpusDir, ".spike-fts");
if (existsSync(spikeDir)) rmSync(spikeDir, { recursive: true, force: true });
const db = await lancedb.connect(spikeDir);
const t1 = performance.now();
const rows = entries.map(rowFor);
const tokMs = performance.now() - t1;
const indexed = rows.slice(0, rows.length - HOLDBACK);
const held = rows.slice(rows.length - HOLDBACK);
const table = await db.createTable("entries", indexed);
const t2 = performance.now();
await table.createIndex("lex", {
  config: lancedb.Index.fts({
    baseTokenizer: "whitespace",
    lowercase: false,
    stem: false,
    removeStopWords: false,
    asciiFolding: false,
    withPosition: false,
  }),
});
const ftsBuildMs = performance.now() - t2;
await table.add(held);
console.error(`build: tokenize ${ms(tokMs)} · fts index over ${indexed.length} rows ${ms(ftsBuildMs)} · +${held.length} un-indexed rows`);

async function fts(q: string, where?: string, limit = pool): Promise<{ id: string; _score: number }[]> {
  const terms = tokenize(q).join(" ");
  if (!terms) return [];
  let query = table.query();
  if (where) query = query.where(where);
  return (await query
    .fullTextSearch(terms, { columns: "lex" })
    .select(["id", "_score"])
    .limit(limit)
    .toArray()) as { id: string; _score: number }[];
}

// --- gate 2: un-indexed rows visible before optimize ------------------------
{
  let found = 0;
  let checked = 0;
  // each held row is looked up by its 3 rarest terms at a small limit — the
  // lookup only succeeds if the un-indexed tail is scored with the index
  const df = new Map<string, number>();
  for (const r of rows) for (const t of new Set(r.lex.split(" "))) df.set(t, (df.get(t) ?? 0) + 1);
  for (const r of held.slice(0, 30)) {
    const terms = [...new Set(r.lex.split(" "))].sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0)).slice(0, 3);
    if (terms.length === 0) continue;
    checked++;
    const hits = await fts(terms.join(" "), undefined, 20);
    if (hits.some((h) => h.id === r.id)) found++;
  }
  console.log(`gate 2 (un-indexed rows searchable before optimize): ${found}/${checked} held-back rows found → ${found === checked ? "PASS" : "FAIL"}`);
}

// --- gate 1: filter + FTS returns filtered rows only -------------------------
const filterCases = manifest.cases.filter((c) => c.filters && Object.keys(c.filters).length);
const byId = new Map(entries.map((e) => [e.id, e]));
{
  // eval filter cases + a random sample of single-field filters from the vocabulary
  const seen = new Set<string>();
  const filters: { f: SearchFilters; q: string }[] = filterCases.map((c) => ({ f: c.filters!, q: c.query }));
  const rnd = (n: number) => Math.floor(Math.random() * n);
  for (let i = 0; i < 60; i++) {
    const e = entries[rnd(entries.length)]!;
    const f: SearchFilters = {};
    const pickKind = i % 4;
    if (pickKind === 0 && e.people[0]) f.person = e.people[0];
    else if (pickKind === 1 && e.tags[0]) f.tag = e.tags[0];
    else if (pickKind === 2) f.type = e.type;
    else f.since = e.date;
    if (pickKind === 3 && e.people[0]) f.person = e.people[0];
    const key = JSON.stringify(f);
    if (seen.has(key)) continue;
    seen.add(key);
    filters.push({ f, q: e.title });
  }
  let violations = 0;
  let empty = 0;
  let runs = 0;
  for (const { f, q } of filters) {
    const where = whereClause(f);
    const hits = await fts(q, where, 200);
    runs++;
    if (hits.length === 0) empty++;
    for (const h of hits) {
      const e = byId.get(h.id);
      if (!e || !matchesFilters(e, f)) violations++;
    }
  }
  console.log(`gate 1 (filter + FTS returns filtered rows only): ${runs} filtered queries, ${violations} rows outside the filter, ${empty} empty → ${violations === 0 ? "PASS" : "FAIL"}`);
}

// --- gate 3: rank agreement with bm25Scores ---------------------------------
function kendallTauB(a: number[], b: number[]): number {
  // τ-b over paired observations (ties handled)
  let concordant = 0;
  let discordant = 0;
  let tiesA = 0;
  let tiesB = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const da = Math.sign(a[i]! - a[j]!);
      const dbb = Math.sign(b[i]! - b[j]!);
      if (da === 0 && dbb === 0) continue;
      if (da === 0) tiesA++;
      else if (dbb === 0) tiesB++;
      else if (da === dbb) concordant++;
      else discordant++;
    }
  }
  const denom = Math.sqrt((concordant + discordant + tiesA) * (concordant + discordant + tiesB));
  return denom === 0 ? 1 : (concordant - discordant) / denom;
}

const lexIdx = buildLexical(entries);

/** Reference BM25 with a configurable k1 (bm25Scores pins k1 = 1.5; Lance uses 1.2). */
function bm25WithK1(query: string, k1: number): Map<string, number> {
  const qTerms = [...new Set(tokenize(query))];
  const live = lexIdx.docs.filter((d): d is NonNullable<typeof d> => d !== null);
  const N = live.length || 1;
  const avgdl = live.reduce((s, d) => s + d.len, 0) / N || 1;
  const b = 0.75;
  const scores = new Map<string, number>();
  for (const t of qTerms) {
    const plist = lexIdx.postings[t];
    if (!plist) continue;
    const n = plist.length;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    for (const [ord, f] of plist) {
      const d = lexIdx.docs[ord];
      if (!d) continue;
      const dl = d.len || 1;
      scores.set(d.id, (scores.get(d.id) ?? 0) + idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / avgdl)))));
    }
  }
  return scores;
}

const phrasings: { text: string; filters: SearchFilters }[] = [];
for (const c of manifest.cases) {
  const qs = buildRecallQueries([c.query, ...(c.phrasings ?? [])], c.filters ?? {}, c.noExpand ?? false);
  for (const q of qs) phrasings.push({ text: q.text, filters: c.filters ?? {} });
}
const sample = phrasings.slice(0, maxQueries);
{
  // τ-b over the union of both top-<pool> lists, on SCORES (so equal-score
  // docs stay tied on both sides instead of being tie-broken arbitrarily);
  // an id missing from one list scores 0 there (below every listed id).
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
  const stats = { k15: [] as number[], k12: [] as number[], overlap: [] as number[], top1: [] as number[] };
  const worst: { tau: number; text: string; ref: [string, number][]; fts: [string, number][] }[] = [];
  let compared = 0;
  for (const p of sample) {
    const filtered = applyFilters(entries, p.filters);
    const allowed = new Set(filtered.map((e) => e.id));
    const hits = await fts(p.text, whereClause(p.filters));
    const ftsTop = hits.filter((h) => allowed.has(h.id));
    const ftsScore = new Map(ftsTop.map((h) => [h.id, h._score]));
    const refFor = (scores: Map<string, number>) =>
      [...scores.entries()].filter(([id]) => allowed.has(id)).sort((x, y) => y[1] - x[1]).slice(0, pool);
    const ref15 = refFor(bm25Scores(p.text, lexIdx));
    const ref12 = refFor(bm25WithK1(p.text, 1.2));
    if (ref15.length === 0 && ftsTop.length === 0) continue;
    compared++;
    // τ is measured over the ids FTS returned, each scored by both systems —
    // the reference scorer covers every doc, so this asks "would our BM25
    // order these same candidates the same way?" (what RRF consumes). Set
    // agreement is reported separately as overlap; big equal-score tie groups
    // make the top-<pool> subset itself arbitrary on both sides.
    const full15 = bm25Scores(p.text, lexIdx);
    const full12 = bm25WithK1(p.text, 1.2);
    for (const [key, full, ref] of [["k15", full15, ref15], ["k12", full12, ref12]] as const) {
      const ids = ftsTop.map((h) => h.id);
      const a = ids.map((id) => full.get(id) ?? 0);
      const b = ids.map((id) => ftsScore.get(id) ?? 0);
      const tau = ids.length < 2 ? 1 : kendallTauB(a, b);
      stats[key].push(tau);
      if (key === "k12") worst.push({ tau, text: p.text, ref: ref12.slice(0, 6), fts: ftsTop.slice(0, 6).map((h) => [h.id, h._score]) });
    }
    const inter = ref15.filter(([id]) => ftsScore.has(id)).length;
    stats.overlap.push(inter / Math.max(ref15.length, ftsTop.length));
    // top-1 agreement counts a tie group as agreement (any max-score doc)
    const refMax = ref15[0]?.[1] ?? 0;
    const refTops = new Set(ref15.filter(([, s]) => s === refMax).map(([id]) => id));
    stats.top1.push(ftsTop[0] && refTops.has(ftsTop[0].id) ? 1 : 0);
  }
  const p10 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length * 0.1)] ?? 1;
  for (const w of worst.sort((x, y) => x.tau - y.tau).slice(0, Number(values.worst))) {
    console.log(`  worst τ ${w.tau.toFixed(3)}  "${w.text}"`);
    console.log(`    ref(k1=1.2): ${w.ref.map(([id, s]) => `${id.slice(0, 28)}:${s.toFixed(2)}`).join("  ")}`);
    console.log(`    fts:         ${w.fts.map(([id, s]) => `${id.slice(0, 28)}:${s.toFixed(2)}`).join("  ")}`);
  }
  const tau15 = mean(stats.k15);
  const tau12 = mean(stats.k12);
  console.log(
    `gate 3 (top-${pool} Kendall τ-b vs bm25Scores over ${compared} phrasings): mean τ ${tau15.toFixed(3)} (p10 ${p10(stats.k15).toFixed(3)}) · vs k1=1.2 reference τ ${tau12.toFixed(3)} (p10 ${p10(stats.k12).toFixed(3)}) · overlap ${(mean(stats.overlap) * 100).toFixed(1)}% · top-1 agreement ${(mean(stats.top1) * 100).toFixed(1)}% → ${tau15 >= 0.95 ? "PASS" : tau12 >= 0.95 ? "PASS at k1=1.2" : "FAIL"}`,
  );
}

// --- gate 4: latency ---------------------------------------------------------
function pct(xs: number[], p: number): number {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}
{
  const lat = { fts: [] as number[], ftsWhere: [] as number[], postings: [] as number[] };
  for (const p of sample.slice(0, 200)) {
    let t = performance.now();
    await fts(p.text);
    lat.fts.push(performance.now() - t);
    t = performance.now();
    await fts(p.text, "type = 'decision'");
    lat.ftsWhere.push(performance.now() - t);
    t = performance.now();
    bm25Scores(p.text, lexIdx);
    lat.postings.push(performance.now() - t);
  }
  const p50 = pct(lat.fts, 0.5);
  console.log(
    `gate 4 (latency per phrasing, ${entries.length} entries): FTS p50 ${ms(p50)} p95 ${ms(pct(lat.fts, 0.95))} · FTS+where p50 ${ms(pct(lat.ftsWhere, 0.5))} · postings bm25 p50 ${ms(pct(lat.postings, 0.5))} → ${p50 < 40 ? "PASS" : "FAIL"} (target < 40 ms at 100k)`,
  );
}

// --- after optimize: gate 2 rows still there, index folds them in ------------
{
  const t = performance.now();
  await table.optimize();
  const stats = await table.indexStats("lex_idx").catch(() => null);
  console.log(`optimize: ${ms(performance.now() - t)} · index stats ${stats ? JSON.stringify(stats) : "n/a"}`);
}
