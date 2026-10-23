import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

function cli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function seeded(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-digest-graph-"));
  seedStore(root);
  runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);
  return root;
}

/** Entry ids filed under a graph's store — entries/ and summaries/ alike. */
function entryIds(root: string, graph: string): string[] {
  const store = graph === "default" ? join(root, "memory") : join(root, "memory-graphs", graph);
  const ids: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(join(dir, ent.name));
      else if (ent.name.endsWith(".md")) ids.push(ent.name.replace(/\.md$/, ""));
    }
  };
  walk(join(store, "entries"));
  walk(join(store, "summaries"));
  return ids;
}

// The #budget entries live ONLY in the default graph; team-x's sole member is
// the #migration note. A shared-graph digest must restrict its candidates to
// that graph's members, so this scope has nothing to summarize — writing one
// anyway would give it `sources` back-links pointing outside the graph.
test("digest --graph restricts candidates to that graph's members", { timeout: 300_000 }, () => {
  const root = seeded();
  try {
    const out = cli(root, ["digest", "--tag", "budget", "--graph", "team-x"]);
    assert.match(out, /nothing to summarize/, "expected no candidates for #budget inside team-x");
    assert.deepEqual(
      entryIds(root, "team-x").filter((id) => id.startsWith("summary-")),
      [],
      "no digest may be written into team-x for a scope with no members",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Ids are unique across ALL stores, so a shared-graph digest must carry its own
// id or it collides with the default graph's digest of the same scope — the
// seed already ships `summary-tag-budget` in the default graph.
test("digest --graph namespaces the digest id by graph", { timeout: 300_000 }, () => {
  const root = seeded();
  try {
    cli(root, ["digest", "--tag", "migration", "--graph", "team-x"]);
    const ids = entryIds(root, "team-x");
    assert.ok(ids.includes("summary-team-x-tag-migration"), `expected a graph-namespaced id, got ${JSON.stringify(ids)}`);
    assert.ok(!ids.includes("summary-tag-migration"), "shared-graph digest must not use the default graph's id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A shared-graph digest may only cite fellow members, otherwise the graph stops
// being self-contained the moment it is handed to its audience.
test("digest --graph cites only fellow members", { timeout: 300_000 }, () => {
  const root = seeded();
  try {
    cli(root, ["digest", "--tag", "migration", "--graph", "team-x"]);
    const members = new Set(entryIds(root, "team-x"));
    const file = join(root, "memory-graphs", "team-x", "summaries", "summary-team-x-tag-migration.md");
    assert.ok(existsSync(file), "digest entry should exist");
    const fm = readFileSync(file, "utf8").split("---")[1] ?? "";
    // Frontmatter list items that look like entry ids (people/teams/tags slugs
    // never start with a date) are the `sources:` back-links.
    const cited = [...fm.matchAll(/^\s*-\s+(\S+)\s*$/gm)]
      .map((m) => m[1] ?? "")
      .filter((s) => /^\d{4}-\d{2}-\d{2}-/.test(s));
    assert.ok(cited.length > 0, "digest should cite at least one source");
    for (const src of cited) assert.ok(members.has(src), `digest cites non-member ${src}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The default graph is unaffected: it may cite anything, and keeps its plain id.
test("digest without --graph still writes the default-graph digest", { timeout: 300_000 }, () => {
  const root = seeded();
  try {
    cli(root, ["digest", "--tag", "needle"]);
    assert.ok(entryIds(root, "default").includes("summary-tag-needle"));
    assert.deepEqual(entryIds(root, "team-x").filter((id) => id.startsWith("summary-")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
