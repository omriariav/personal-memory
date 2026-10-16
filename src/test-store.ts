import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Test-only helpers for integration tests that need the engine rooted at a
 * scratch store. `src/ingest.ts` captures process.cwd() at import time, so
 * the engine runs in a child process whose cwd is the scratch root (pattern
 * from src/store-headers.test.ts). Never used by production code.
 */
export const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
export const STORE_MOD = JSON.stringify(join(REPO, "src", "store.ts"));
export const RECALL_MOD = JSON.stringify(join(REPO, "src", "recall.ts"));

function yamlList(xs: string[]): string {
  return xs.length ? `[${xs.join(", ")}]` : "[]";
}

export function md(fm: Record<string, unknown>, body: string): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    lines.push(Array.isArray(v) ? `${k}: ${yamlList(v as string[])}` : `${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "", body, "");
  return lines.join("\n");
}

export interface SeedEntry {
  id: string;
  date: string;
  type: string;
  title: string;
  body: string;
  people?: string[];
  teams?: string[];
  tags?: string[];
  sources?: string[];
  follows?: string[];
  source_ids?: string[];
  /** Graph memberships; "default" is always the home. Shared copies are byte-identical. */
  graphs?: string[];
}

export const GOLDEN_ENTRIES: SeedEntry[] = [
  { id: "2026-01-01-zebra-migration", date: "2026-01-01", type: "note", title: "Zebra migration plan", people: ["ana-levi"], teams: ["platform"], tags: ["migration"], body: "long body about databases and regions ".repeat(20).trim(), graphs: ["default", "team-x"] },
  { id: "2026-01-02-quokka-budget", date: "2026-01-02", type: "decision", title: "Quokka budget review", people: ["boris-cohen", "ana-levi"], tags: ["budget"], body: "spending and forecasts ".repeat(20).trim(), source_ids: ["slack:C1:1.0"] },
  { id: "2026-01-03-otter-hiring", date: "2026-01-03", type: "hiring", title: "Otter hiring loop", people: ["chen-mizrahi"], teams: ["platform"], body: "interviews and offers ".repeat(20).trim() },
  { id: "2026-01-04-budget-pending", date: "2026-01-04", type: "pending-decision", title: "Budget freeze pending", people: ["boris-cohen"], tags: ["budget"], body: "Should we freeze the budget until the forecast settles?" },
  { id: "2026-01-05-budget-decided", date: "2026-01-05", type: "decision", title: "Budget freeze approved", people: ["boris-cohen"], tags: ["budget"], follows: ["2026-01-04-budget-pending"], body: "Freeze approved: spending paused until the quarterly forecast settles." },
  { id: "2026-01-06-rare-codeword", date: "2026-01-06", type: "event", title: "Rare codeword event", tags: ["needle"], body: "codeword zephyr quokka adopted as the internal protocol name." },
  { id: "summary-tag-budget", date: "2026-01-07", type: "summary", title: "Rolling summary — #budget", people: ["boris-cohen"], tags: ["budget"], sources: ["2026-01-02-quokka-budget", "2026-01-04-budget-pending", "2026-01-05-budget-decided"], body: "## Synthesis\n\nBudget was reviewed, a freeze was proposed and then approved." },
];

function entryFile(e: SeedEntry): string {
  return md(
    { id: e.id, date: e.date, type: e.type, title: e.title, people: e.people ?? [], teams: e.teams ?? [], tags: e.tags ?? [], sources: e.sources, follows: e.follows, source_ids: e.source_ids },
    e.body,
  );
}

export function seedStore(root: string, entries: SeedEntry[] = GOLDEN_ENTRIES): void {
  for (const e of entries) {
    const file = entryFile(e);
    for (const g of e.graphs ?? ["default"]) {
      const store = g === "default" ? join(root, "memory") : join(root, "memory-graphs", g);
      const [y, m] = e.date.split("-");
      const dir = e.type === "summary" ? join(store, "summaries") : join(store, "entries", y!, m!);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${e.id}.md`), file, "utf8");
    }
  }
}

/** Run `script` (an async body) in a child process rooted at `cwd`; returns the JSON parsed from the last stdout line. */
export function runInStore(cwd: string, script: string, env: Record<string, string> = {}): unknown {
  const wrapped = `(async () => { ${script} })().catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), "-e", wrapped], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_RANK_PROFILE: "current", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

/** Replace the scratch root in every string so fixtures are machine-independent. */
export function normalizeReport(report: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(report).split(root).join("<root>"));
}
