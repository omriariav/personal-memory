import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { loadAllEntries, ROOT } from "./ingest.js";
import { requireGraph } from "./graphs.js";
import { commitMemoryRepo } from "./memory-git.js";
import { getEmbedder } from "./embed.js";
import { searchDetailed, type SearchFilters } from "./store.js";
import { recall } from "./recall.js";
import {
  compareReports,
  evaluateCase,
  renderText,
  runCases,
  summarize,
  type CaseResult,
  type EvalCase,
  type EvalReport,
} from "./eval.js";
import { addGoldenCase, goldenPaths, readGolden, writeGolden } from "./golden.js";

/**
 * `memory eval …` — the private golden set (real queries, user-confirmed
 * answers) and the runner that scores the live store against it. Output can
 * contain real titles and ids: it stays in the terminal and under memory/eval/.
 */

const USAGE =
  'usage: memory eval add-golden "<query>" ["<agent phrasing>" …] --expect <id,…>\n' +
  "                        [--person|--type|--team|--tag|--since|--until|--graph …]\n" +
  '                        [--must-outrank <winner>:<loser>]… [--absent <id,…>] [--notes "…"] [--k N] [--pass-at N] [--no-expand]\n' +
  "       memory eval list\n" +
  "       memory eval remove-golden <id>\n" +
  "       memory eval run [--json <out>] [--compare] [--baseline <path>] [--save-baseline] [--mode recall|search] [--only <id-prefix>]";

export async function cmdEval(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "add-golden") return addGolden(argv.slice(1));
  if (sub === "list") return listGolden();
  if (sub === "remove-golden") return removeGolden(argv.slice(1));
  if (sub === "run") return runGolden(argv.slice(1));
  throw new Error(USAGE);
}

const csv = (s: unknown) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function filtersFrom(values: Record<string, unknown>): SearchFilters | undefined {
  const f: SearchFilters = {
    person: (values.person as string) || undefined,
    type: (values.type as string) || undefined,
    team: (values.team as string) || undefined,
    tag: (values.tag as string) || undefined,
    since: (values.since as string) || undefined,
    until: (values.until as string) || undefined,
    graph: values.graph ? requireGraph(values.graph) : undefined,
  };
  const compact = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as SearchFilters;
  return Object.keys(compact).length ? compact : undefined;
}

function describe(r: CaseResult): string {
  const ranks = Object.entries(r.ranks)
    .map(([id, rank]) => `${id} @ ${rank ?? "—"}`)
    .join(", ");
  const pairs = r.pairs.map((p) => `${p.winner} ${p.ok ? ">" : "≯"} ${p.loser}`).join(", ");
  return `${r.pass ? "✓ pass" : "✗ fail"}  ${ranks}${pairs ? `  · ${pairs}` : ""}  (${r.ms} ms)`;
}

async function addGolden(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      expect: { type: "string" },
      person: { type: "string" },
      type: { type: "string" },
      team: { type: "string" },
      tag: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      graph: { type: "string" },
      "must-outrank": { type: "string", multiple: true },
      absent: { type: "string" },
      notes: { type: "string" },
      k: { type: "string" },
      "pass-at": { type: "string" },
      "no-expand": { type: "boolean" },
    },
    allowPositionals: true,
  });
  const [query, ...phrasings] = positionals.map((p) => p.trim()).filter(Boolean);
  if (!query) throw new Error(USAGE);

  const expect = csv(values.expect);
  const absent = csv(values.absent);
  const pairs = (values["must-outrank"] ?? []).map((s) => {
    const [winner, loser] = s.split(":").map((x) => x.trim());
    if (!winner || !loser) throw new Error(`--must-outrank expects <winner>:<loser>, got '${s}'`);
    return [loser, winner] as [string, string];
  });

  const known = new Set((await loadAllEntries()).map((e) => e.id));
  for (const id of [...expect, ...absent, ...pairs.flat()]) {
    if (!known.has(id)) throw new Error(`unknown entry id '${id}' — golden cases must reference existing entries`);
  }

  const cases = await readGolden();
  const next = addGoldenCase(cases, {
    query,
    ...(phrasings.length ? { phrasings } : {}),
    ...(filtersFrom(values) ? { filters: filtersFrom(values) } : {}),
    expect,
    ...(pairs.length ? { mustNotOutrank: pairs } : {}),
    ...(absent.length ? { expectAbsent: absent } : {}),
    ...(values.notes ? { notes: values.notes } : {}),
    ...(values.k ? { k: Number(values.k) } : {}),
    ...(values["pass-at"] ? { passAtK: Number(values["pass-at"]) } : {}),
    ...(values["no-expand"] ? { noExpand: true } : {}),
  });
  const c = next[next.length - 1]!;

  // Run it once now so the user sees where the answer ranks today.
  const [r] = await runCases([c], { recall, searchDetailed }, { mode: "recall", now: Date.now() });
  console.log(`${c.id}: ${describe(r!)}`);

  const path = await writeGolden(next);
  await commitMemoryRepo(`eval: add golden ${c.id}`);
  console.log(`✓ saved ${c.id} to ${relative(ROOT, path)} (${next.length} golden case${next.length === 1 ? "" : "s"})`);
}

async function listGolden() {
  const cases = await readGolden();
  if (cases.length === 0) {
    console.log("no golden cases yet — add one with: memory eval add-golden \"<query>\" --expect <id>");
    return;
  }
  const paths = goldenPaths();
  let last: Map<string, CaseResult> | null = null;
  if (existsSync(paths.lastRun)) {
    const rep = JSON.parse(await readFile(paths.lastRun, "utf8")) as EvalReport;
    last = new Map(rep.results.map((r) => [r.id, r]));
  }
  for (const c of cases) {
    const expected = Array.isArray(c.expect) ? c.expect : Object.keys(c.expect);
    const asserts = [
      ...expected,
      ...(c.mustNotOutrank ?? []).map(([loser, winner]) => `${winner} > ${loser}`),
      ...(c.expectAbsent ?? []).map((id) => `¬${id}`),
    ];
    const status = last?.get(c.id) ? (last.get(c.id)!.pass ? "✓" : "✗") : "·";
    console.log(`${status} ${c.id}  "${c.query}"  → ${asserts.join(", ")}${c.filters ? `  ${JSON.stringify(c.filters)}` : ""}`);
  }
  console.log(`${cases.length} golden case${cases.length === 1 ? "" : "s"}${last ? " (status from last run)" : ""}`);
}

async function removeGolden(argv: string[]) {
  const id = argv[0];
  if (!id) throw new Error("usage: memory eval remove-golden <id>");
  const cases = await readGolden();
  if (!cases.some((c) => c.id === id)) throw new Error(`no golden case ${id}`);
  await writeGolden(cases.filter((c) => c.id !== id));
  await commitMemoryRepo(`eval: remove golden ${id}`);
  console.log(`✓ removed ${id}`);
}

async function runGolden(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "string" },
      compare: { type: "boolean" },
      baseline: { type: "string" },
      "save-baseline": { type: "boolean" },
      mode: { type: "string" },
      only: { type: "string" },
    },
    allowPositionals: false,
  });
  const paths = goldenPaths();
  const all = await readGolden();
  const cases = values.only ? all.filter((c) => c.id.startsWith(values.only!)) : all;
  if (cases.length === 0) {
    console.log(all.length ? `no golden case matches --only ${values.only}` : "no golden cases yet — nothing to run");
    return;
  }
  const mode = values.mode === "search" ? "search" : "recall";

  // warm-up so model load is not charged to the first case
  await recall(["warm up"], { k: 1 });
  const results = await runCases(cases, { recall, searchDetailed }, { mode, now: Date.now() });
  for (const r of results) console.log(`${r.id}: ${describe(r)}`);

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    // not a git checkout
  }
  const report: EvalReport = {
    meta: {
      at: new Date().toISOString(),
      commit,
      node: process.version,
      embedderId: getEmbedder().id,
      corpus: "real-store",
      mode,
      now: "wall clock",
    },
    summary: summarize(results),
    results,
  };
  console.log("");
  console.log(renderText(report));

  const out = values.json ?? paths.lastRun;
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${relative(ROOT, out)}`);

  const comparePath = values.compare || values.baseline ? (values.baseline ?? paths.baseline) : undefined;
  if (comparePath !== undefined) {
    if (!existsSync(comparePath)) {
      console.log(`no baseline at ${relative(ROOT, comparePath)} — record one with: memory eval run --save-baseline`);
    } else {
      const base = JSON.parse(await readFile(comparePath, "utf8")) as EvalReport;
      const cmp = compareReports(base, report);
      console.log(`\n--- vs ${relative(ROOT, comparePath)} (${base.meta.commit}, ${base.meta.at})\n${cmp.text}`);
      if (cmp.regressed) process.exitCode = 2;
    }
  }
  if (values["save-baseline"]) {
    await writeFile(paths.baseline, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await commitMemoryRepo("eval: save golden baseline");
    console.log(`✓ saved baseline to ${relative(ROOT, paths.baseline)}`);
  }
}

// exported for tests / other callers that already hold hits
export { evaluateCase };
