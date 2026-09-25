#!/usr/bin/env -S npx tsx
/**
 * Retrieval-quality harness over a deterministic synthetic corpus.
 *
 *   npx tsx scripts/eval-retrieval.ts [--size 4000] [--seed 42] [--mode recall|search]
 *       [--fresh] [--json out.json] [--md out.md] [--compare baseline.json]
 *       [--fail-on-regression] [--only <kind-or-id-prefix>] [--allow-remote]
 *
 * The corpus and its index are cached under <repo>/.cache/eval/ per
 * (size, seed, generator version); a cached run costs one incremental sync.
 *
 * IMPORTANT: src/ingest.ts captures process.cwd() at module load, so this
 * script chdir()s into the corpus BEFORE dynamically importing any src/
 * module that touches the store. The only static src/ import is the corpus
 * generator, which has no store dependency.
 */
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GEN_VERSION, generateCorpus, type CorpusManifest } from "../src/eval-corpus.js";
import { compareReports, renderMarkdown, renderText, runCases, summarize, type EvalReport } from "../src/eval.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    size: { type: "string", default: "4000" },
    seed: { type: "string", default: "42" },
    mode: { type: "string", default: "recall" },
    fresh: { type: "boolean", default: false },
    json: { type: "string" },
    md: { type: "string" },
    compare: { type: "string" },
    "fail-on-regression": { type: "boolean", default: false },
    only: { type: "string" },
    "allow-remote": { type: "boolean", default: false },
  },
});

const size = Number(values.size);
const seed = Number(values.seed);
const mode = values.mode === "search" ? "search" : "recall";
if (!Number.isInteger(size) || size < 100) throw new Error("--size must be an integer ≥ 100");

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const startCwd = process.cwd();
const abs = (p: string | undefined) => (p ? resolve(startCwd, p) : undefined);
const jsonOut = abs(values.json);
const mdOut = abs(values.md);
const comparePath = abs(values.compare);

// --- local-only + model cache guard ----------------------------------------
const backend = (process.env.MEMORY_EMBEDDINGS ?? "local").toLowerCase();
if (backend !== "local" && !values["allow-remote"]) {
  throw new Error(`MEMORY_EMBEDDINGS=${backend} would send synthetic text to a remote API; pass --allow-remote to confirm`);
}
process.env.MEMORY_MODEL_CACHE ??= join(repoRoot, ".cache", "transformers");
const model = process.env.MEMORY_EMBED_MODEL ?? "Xenova/bge-small-en-v1.5";
if (backend === "local" && !existsSync(join(process.env.MEMORY_MODEL_CACHE, model))) {
  throw new Error(
    `embedding model not cached at ${process.env.MEMORY_MODEL_CACHE}/${model} — run \`npx tsx src/cli.ts index\` once in the repo (online) first`,
  );
}

// --- corpus cache -----------------------------------------------------------
// The cache is keyed by (size, seed) only: a generator bump regenerates the
// corpus IN PLACE. Entry bytes are deterministic, so unchanged entries keep
// their content hash and the index sync reuses their vectors — only the case
// manifest (and any genuinely new entries) change.
const evalCache = join(repoRoot, ".cache", "eval");
const corpusDir = join(evalCache, `corpus-${size}-s${seed}`);
const legacyDir = join(evalCache, `corpus-${size}-s${seed}-g1`);
if (!existsSync(corpusDir) && existsSync(legacyDir)) renameSync(legacyDir, corpusDir);
if (values.fresh && existsSync(corpusDir)) {
  if (!corpusDir.startsWith(evalCache + "/")) throw new Error(`refusing to remove ${corpusDir}`);
  console.error(`↻ --fresh: removing cached corpus ${corpusDir}`);
  rmSync(corpusDir, { recursive: true, force: true });
}
mkdirSync(corpusDir, { recursive: true });
const manifestPath = join(corpusDir, "eval-cases.json");
let manifest: CorpusManifest | null = existsSync(manifestPath)
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as CorpusManifest)
  : null;
if (manifest && manifest.generator === GEN_VERSION) {
  console.error(`corpus: cached ${manifest.entries} entries, ${manifest.cases.length} cases (${corpusDir})`);
} else {
  console.error(
    manifest
      ? `corpus: generator ${manifest.generator} → ${GEN_VERSION}, regenerating in place (vectors reused by hash) …`
      : `corpus: generating ${size} entries (seed ${seed}) …`,
  );
  manifest = await generateCorpus({ root: corpusDir, total: size, seed });
  console.error(`corpus: ${manifest.entries} entries, ${manifest.cases.length} cases`);
}

// --- enter the corpus, then load the engine ---------------------------------
process.chdir(corpusDir);
const ingest = await import("../src/ingest.js");
if (!ingest.INDEX_DIR.startsWith(corpusDir)) throw new Error(`engine rooted at ${ingest.INDEX_DIR}, expected ${corpusDir}`);
const store = await import("../src/store.js");
const { recall } = await import("../src/recall.js");
const { getEmbedder } = await import("../src/embed.js");

const embedder = getEmbedder();
console.error(`index: syncing (${embedder.id}; ~55 chunks/s on CPU when embedding is needed) …`);
const t0 = performance.now();
const sync = await store.syncIndex();
const buildMs = Math.round(performance.now() - t0);
console.error(`index: +${sync.added} −${sync.removed} unchanged ${sync.unchanged} in ${(buildMs / 1000).toFixed(1)} s`);

// warm-up (model load) — excluded from per-case latency
const warm = await recall(["warm up"], { k: 1, now: Date.UTC(2026, 6, 1) });

// --- run ---------------------------------------------------------------------
const only = values.only;
const cases = only ? manifest.cases.filter((c) => c.kind === only || c.id.startsWith(only)) : manifest.cases;
if (cases.length === 0) throw new Error(`--only ${only} matched no cases`);
const now = Date.UTC(2026, 6, 1); // just after the corpus' last date; recency is stable forever
let failed = 0;
const results = await runCases(cases, { recall, searchDetailed: store.searchDetailed }, {
  mode,
  now,
  onCase: (r, i, n) => {
    if (!r.pass && !r.xfail) failed++;
    if ((i + 1) % 25 === 0 || i + 1 === n) process.stderr.write(`  ${i + 1}/${n} cases · ${failed} failing\n`);
  },
});

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", repoRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  // not a git checkout
}
const report: EvalReport = {
  meta: {
    at: new Date().toISOString(),
    commit,
    node: process.version,
    embedderId: embedder.id,
    corpus: { size, seed, generator: manifest.generator, chunkRows: warm.chunkRows, buildMs },
    mode,
    now: new Date(now).toISOString(),
  },
  summary: summarize(results),
  results,
};

console.log(renderText(report));
if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(report, null, 2), "utf8");
  console.error(`wrote ${jsonOut}`);
}
if (mdOut) {
  mkdirSync(dirname(mdOut), { recursive: true });
  writeFileSync(mdOut, renderMarkdown(report), "utf8");
  console.error(`wrote ${mdOut}`);
}
if (comparePath) {
  if (!existsSync(comparePath)) {
    console.error(`no baseline at ${comparePath} — run \`npm run eval:baseline\` to record one`);
  } else {
    const base = JSON.parse(readFileSync(comparePath, "utf8")) as EvalReport;
    const cmp = compareReports(base, report);
    console.log(`\n--- vs ${comparePath} (${base.meta.commit}, ${base.meta.at})\n${cmp.text}`);
    if (cmp.regressed && values["fail-on-regression"]) process.exitCode = 2;
  }
}
