import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slotHint } from "./maintenance.js";
import { REPO, STORE_MOD, md, runInStore, seedStore } from "./test-store.js";

/**
 * `maintenance` is a READ: it reports every slot honestly (built / active,
 * never re-derived) and never builds or syncs anything. `optimizeIndex` is the
 * matching write — the only thing that folds rows appended since the FTS index
 * was built back into it, for EVERY built slot rather than just the active one.
 */
const BUILD_MOD = JSON.stringify(join(REPO, "src", "slot-build.ts"));
const LANCE = JSON.stringify(join(REPO, "node_modules", "@lancedb", "lancedb", "dist", "index.js"));

/** FTS coverage of one slot's catalog, read straight from LanceDB rather than from the code under test. */
const FTS_STATS = `
  const lancedb = await import(${LANCE});
  async function ftsStats(dir) {
    const db = await lancedb.connect(dir);
    const t = await db.openTable("entries");
    const idx = (await t.listIndices()).find((i) => i.columns.includes("lex"));
    if (!idx) return null;
    const st = await t.indexStats(idx.name);
    return st ? { indexed: st.numIndexedRows, unindexed: st.numUnindexedRows } : null;
  }
`;

const row = (name: string, format: 1 | 2, active = false) => ({
  name,
  format,
  active,
  previous: false,
  built: true,
  building: false,
  entries: 1,
  chunks: 1,
  lastSync: null,
});

function cliIn(root: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args],
    { cwd: root, env: { ...process.env, MEMORY_EMBEDDINGS: "fake" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("slotHint: only when the store is large and no new-format slot exists", () => {
  assert.equal(slotHint([row("legacy", 1, true)], 1999), null, "a small store is never nagged");
  assert.match(
    slotHint([row("legacy", 1, true)], 2001) ?? "",
    /index --build next.*--index-slot next.*--activate next/,
    "the hint names build → try → activate, in that order",
  );
  assert.equal(slotHint([row("legacy", 1, true), row("next", 2)], 50_000), null, "a built next slot already answers the hint");
  assert.equal(slotHint([row("main", 2, true)], 50_000), null, "a store already on the new format is never nagged");
});

test("slotHint: an unbuilt new-format slot does not count as one that exists", () => {
  const unbuilt = { ...row("next", 2), built: false };
  assert.match(slotHint([row("legacy", 1, true), unbuilt], 50_000) ?? "", /index --build next/, "a half-made slot still needs building");
});

test("maintenance prints the slot table and index --optimize folds the FTS index on the next slot", { timeout: 300_000 }, () => {
  // realpathSync: tmpdir() lives under a symlinked /var on macOS, and the
  // engine's own process.cwd() reports the canonical path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-maint-")));
  const nextDir = JSON.stringify(join(root, ".index", "slots", "next"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    cliIn(root, ["index", "--build", "next"]);

    const out = cliIn(root, ["maintenance"]);
    assert.match(out, /## Index health/, "the index-health section is still there");
    assert.match(out, /legacy\s+1\s+active/, "the legacy root is reported as the active slot");
    assert.match(out, /next\s+2\s+built/, "the built next slot is reported beside it");
    assert.doesNotMatch(out, /hint: /, "7 entries: no hint");

    // A row appended AFTER the FTS index was built is searchable but not yet
    // folded in — that gap is exactly what optimize closes.
    writeFileSync(
      join(root, "memory", "entries", "2026", "01", "2026-01-09-penguin-rollout.md"),
      md({ id: "2026-01-09-penguin-rollout", date: "2026-01-09", type: "note", title: "Penguin rollout", people: [], teams: [], tags: ["rollout"] }, "penguin rollout body text"),
    );
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);

    const r = runInStore(
      root,
      `${FTS_STATS}
       const s = await import(${STORE_MOD});
       const before = await ftsStats(${nextDir});
       const opt = await s.optimizeIndex(7);
       const after = await ftsStats(${nextDir});
       console.log(JSON.stringify({ before, opt, after }));`,
    ) as {
      before: { indexed: number; unindexed: number } | null;
      after: { indexed: number; unindexed: number } | null;
      opt: { tableExists: boolean; slots: { slot: string; format: number; fts: { indexed: number; unindexed: number } | null }[] };
    };

    assert.equal(r.opt.tableExists, true, "the active slot's chunk table was optimized");
    assert.deepEqual(r.opt.slots.map((s) => s.slot), ["legacy", "next"], "every built slot is optimized, active first");
    assert.deepEqual(r.opt.slots.map((s) => s.format), [1, 2], "each slot reports its own format");
    assert.equal(r.opt.slots[0]!.fts, null, "legacy slot has no FTS index");
    assert.ok(r.before && r.before.unindexed > 0, `the appended row was outside the FTS index before optimize, got: ${JSON.stringify(r.before)}`);
    assert.equal(r.opt.slots[1]!.fts?.unindexed, 0, "optimize folded every row into the FTS index");
    assert.deepEqual(r.after, { indexed: 8, unindexed: 0 }, "LanceDB agrees: all 8 entries are indexed");

    // active.json pointing at a slot that is not on disk: maintenance says so
    // rather than silently answering from the legacy fallback.
    writeFileSync(join(root, ".index", "active.json"), `${JSON.stringify({ slot: "ghost" }, null, 2)}\n`, "utf8");
    const warned = cliIn(root, ["maintenance"]);
    assert.match(warned, /⚠ active\.json names slot 'ghost'/, "the dangling activation is reported");
    assert.match(warned, /legacy\s+1\s+active/, "and the table still shows what is actually being read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optimizeIndex: a broken non-active slot is reported, never fatal to the others", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-maint-broken-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD_MOD}); console.log(JSON.stringify(await b.buildSlot({ name: "next" })));`);
    // A slot that looks built (meta.json) but whose catalog table is rubble.
    const broken = join(root, ".index", "slots", "broken");
    mkdirSync(join(broken, "entries.lance"), { recursive: true });
    writeFileSync(
      join(broken, "meta.json"),
      `${JSON.stringify(
        { format: 2, indexVersion: 6, embedderId: "fake", dim: 8, catalogVersion: 1, vectorIndex: "flat", headerTable: false, lexical: "fts", builtAt: "2026-01-01T00:00:00.000Z" },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const opt = runInStore(
      root,
      `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.optimizeIndex(7)));`,
    ) as { slots: { slot: string; error?: string; fts: { unindexed: number } | null }[] };

    assert.deepEqual(opt.slots.map((s) => s.slot), ["legacy", "broken", "next"], "the broken slot is still reported");
    assert.equal(opt.slots[0]!.error, undefined, "the active slot succeeded");
    assert.ok(opt.slots[1]!.error, "the broken slot carries its failure");
    assert.equal(opt.slots[2]!.error, undefined, "the healthy slot after it was optimized anyway");
    assert.equal(opt.slots[2]!.fts?.unindexed, 0, "and its FTS index is folded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optimizeIndex: a non-active slot with an unreadable meta.json is still reported with its format", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-maint-badmeta-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD_MOD}); console.log(JSON.stringify(await b.buildSlot({ name: "next" })));`);
    // Both halves broken: unparseable meta.json AND rubble where the catalog
    // should be. The error row must still carry the slot's format, which is
    // why the reporting path may not re-read anything about the slot.
    const rubble = join(root, ".index", "slots", "rubble");
    mkdirSync(join(rubble, "entries.lance"), { recursive: true });
    writeFileSync(join(rubble, "meta.json"), "{ not json", "utf8");
    const opt = runInStore(
      root,
      `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.optimizeIndex(7)));`,
    ) as { slots: { slot: string; format: number; error?: string; fts: { unindexed: number } | null }[] };

    assert.deepEqual(opt.slots.map((s) => s.slot), ["legacy", "next", "rubble"], "every built slot is still reported");
    assert.ok(opt.slots[2]!.error, "the slot with the unreadable meta.json carries its failure");
    assert.equal(opt.slots[2]!.format, 2, "and its format, resolved before the failure rather than after it");
    assert.equal(opt.slots[1]!.error, undefined, "the healthy slot was optimized anyway");
    assert.equal(opt.slots[1]!.fts?.unindexed, 0, "and its FTS index is folded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maintenance on a store with entries but no index reports instead of refusing", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-maint-noindex-")));
  try {
    seedStore(root);
    // No sync, no build: Markdown on disk and nothing under .index/ at all.
    const out = cliIn(root, ["maintenance"]);
    assert.match(out, /## Index health/, "the one section it can still report comes first");
    assert.match(out, /entries 7 · indexed 0 .* \(no index\)/, "the counts it can see from the Markdown");
    assert.match(out, /no index built for slot "main"/, "the health line says what is missing");
    assert.match(out, /→ fix: npx tsx src\/cli\.ts index/, "and names the command that fixes it");
    assert.match(out, /^slot\s+format\s+state\s+entries\s+chunks\s+last sync$/m, "the slot table is still printed");
    assert.match(out, /^main\s+2\s+active\s+-\s+-\s+-$/m, "showing the resolved slot as unbuilt");
    assert.match(out, /skipped: no index built — run: npx tsx src\/cli\.ts index/, "and the catalog-backed sections are skipped, not reported empty");
    assert.doesNotMatch(out, /no scope has ≥/, "digest debt is not reported as empty");
    assert.doesNotMatch(out, /no suspiciously-similar slugs/, "slug hygiene is not reported as empty");
    assert.ok(!existsSync(join(root, ".index", "slots", "main")), "a read never materialized the slot it resolved to");
    assert.ok(!existsSync(join(root, ".index", "graph-maintenance.json")), "and never wrote the hygiene audit it could not compute");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
