#!/usr/bin/env -S npx tsx
/**
 * Deterministic synthetic-corpus generator for retrieval verification.
 * Run from a SCRATCH directory (the CLI roots everything at process.cwd()):
 *
 *   cd /path/to/scratch && npx tsx /path/to/repo/scripts/gen-corpus.ts [--total 4000] [--seed 42]
 *
 * Writes the base entries, 20 needles and the evaluation case families, plus
 * `eval-cases.json` (the manifest scripts/eval-retrieval.ts consumes) and the
 * legacy `needles.json`. Never run it inside the real repo. The generator
 * itself lives in src/eval-corpus.ts.
 */
import { parseArgs } from "node:util";
import { generateCorpus } from "../src/eval-corpus.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { total: { type: "string" }, seed: { type: "string" } },
});

const root = process.cwd();
const manifest = await generateCorpus({
  root,
  total: values.total ? Number(values.total) : undefined,
  seed: values.seed ? Number(values.seed) : undefined,
});
console.log(`✓ generated ${manifest.entries} entries and ${manifest.cases.length} eval cases under ${root}/memory`);
