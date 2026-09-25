import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Integration: the header table is filled for changed entries at sync time,
 * backfilled in bounded batches for the rest, and searched as its own leg.
 * The engine roots itself at process.cwd() at import time, so this runs the
 * store in a child process inside a scratch store, with the fake embedder.
 */

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function md(id: string, date: string, title: string, body: string): string {
  return `---\nid: ${id}\ndate: "${date}"\ntype: note\ntitle: "${title}"\npeople: []\nteams: []\ntags: []\n---\n\n${body}\n`;
}

function runInStore(cwd: string, script: string): any {
  // tsx by absolute path: the child's cwd is the scratch store, not the repo.
  // The script is wrapped in an async function: `node -e` has no top-level
  // await on Node 18, and the repo's floor is Node 20 but a developer's
  // default shell may be older.
  const wrapped = `(async () => { ${script} })().catch((e) => { console.error(e); process.exit(1); });`;
  const out = execFileSync(process.execPath, ["--import", join(repo, "node_modules", "tsx", "dist", "loader.mjs"), "-e", wrapped], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_RANK_HEADER_LEG_WEIGHT: "1" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop()!);
}

test("headers: synced for changed entries, backfilled in batches, searched as the header leg", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-headers-"));
  try {
    const dir = join(root, "memory", "entries", "2026", "01");
    mkdirSync(dir, { recursive: true });
    const ids = ["2026-01-01-zebra-migration", "2026-01-02-quokka-budget", "2026-01-03-otter-hiring"];
    writeFileSync(join(dir, `${ids[0]}.md`), md(ids[0]!, "2026-01-01", "Zebra migration plan", "long body about databases and regions ".repeat(20)));
    writeFileSync(join(dir, `${ids[1]}.md`), md(ids[1]!, "2026-01-02", "Quokka budget review", "spending and forecasts ".repeat(20)));
    writeFileSync(join(dir, `${ids[2]}.md`), md(ids[2]!, "2026-01-03", "Otter hiring loop", "interviews and offers ".repeat(20)));

    const storeMod = JSON.stringify(join(repo, "src", "store.ts"));
    // 1. First sync embeds chunks AND headers for every (new) entry.
    const first = runInStore(
      root,
      `const s = await import(${storeMod}); await s.syncIndex(); console.log(JSON.stringify(await s.headerStatus()));`,
    );
    assert.deepEqual(first, { entries: 3, headers: 3, missing: 0 });

    // 2. Simulate a pre-existing index without headers: drop the table, then a
    //    no-op sync must NOT rebuild them (that is the backfill's job).
    const dropped = runInStore(
      root,
      `const s = await import(${storeMod}); await s.dropHeadersForTest(); await s.syncIndex(); console.log(JSON.stringify(await s.headerStatus()));`,
    );
    assert.deepEqual(dropped, { entries: 3, headers: 0, missing: 3 });

    // 3. Bounded backfill: batch 2 fills two, the next call fills the last one.
    const b1 = runInStore(
      root,
      `const s = await import(${storeMod}); const r = await s.backfillHeaders({ batch: 2 }); console.log(JSON.stringify({ r, status: await s.headerStatus() }));`,
    );
    assert.deepEqual(b1, { r: { embedded: 2, remaining: 1 }, status: { entries: 3, headers: 2, missing: 1 } });
    const b2 = runInStore(
      root,
      `const s = await import(${storeMod}); const r = await s.backfillHeaders({ batch: 2 }); console.log(JSON.stringify({ r, status: await s.headerStatus() }));`,
    );
    assert.deepEqual(b2, { r: { embedded: 1, remaining: 0 }, status: { entries: 3, headers: 3, missing: 0 } });

    // 4. A changed entry gets its header refreshed at sync time.
    writeFileSync(join(dir, `${ids[1]}.md`), md(ids[1]!, "2026-01-02", "Quokka budget review v2", "spending and forecasts ".repeat(20)));
    const refreshed = runInStore(
      root,
      `const s = await import(${storeMod}); const sync = await s.syncIndex(); console.log(JSON.stringify({ sync, status: await s.headerStatus() }));`,
    );
    assert.equal(refreshed.sync.added, 1);
    assert.deepEqual(refreshed.status, { entries: 3, headers: 3, missing: 0 });

    // 5. The header leg: a title-only question ranks the named entry first via the header list.
    const hit = runInStore(
      root,
      `const s = await import(${storeMod}); const r = await s.searchDetailed(["Otter hiring loop"], {}, 3, { completeness: "none", tunables: { HEADER_LEG_WEIGHT: 1 } }); console.log(JSON.stringify({ ids: r.hits.map((h) => h.entry.id), signals: r.hits[0]?.reasons?.retrievalSignals, headerRank: r.hits[0]?.reasons?.headerRank }));`,
    );
    assert.equal(hit.ids[0], ids[2]);
    assert.ok(hit.signals.includes("header"), `signals: ${hit.signals}`);
    assert.equal(hit.headerRank, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
