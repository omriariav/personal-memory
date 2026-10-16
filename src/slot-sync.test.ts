import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, md, runInStore, seedStore } from "./test-store.js";

/**
 * Writers keep EVERY built slot in sync, not just the active one, so a `next`
 * slot under evaluation never drifts from the Markdown source of truth — and
 * a changed chunk is embedded exactly once no matter how many slots hold it.
 *
 * The seeding sync is pinned to `MEMORY_INDEX_SLOT=legacy`: the store under
 * test is a legacy root with a `next` slot beside it, and an index-less store
 * would otherwise take the fresh new-format default.
 */
const BUILD_MOD = JSON.stringify(join(REPO, "src", "slot-build.ts"));
const EMBED_MOD = JSON.stringify(join(REPO, "src", "embed.ts"));
const LANCE = JSON.stringify(join(REPO, "node_modules", "@lancedb", "lancedb", "dist", "index.js"));

const COUNT_ROWS = `
  const lancedb = await import(${LANCE});
  async function count(dir, table) { const db = await lancedb.connect(dir); if (!(await db.tableNames()).includes(table)) return 0; return (await db.openTable(table)).countRows(); }
`;

/** Counts every text handed to the embedder, so "embedded once" is measured, not assumed. */
const COUNT_EMBEDS = `
  const { FakeEmbedder } = await import(${EMBED_MOD});
  const embed = FakeEmbedder.prototype.embed; let calls = 0;
  FakeEmbedder.prototype.embed = function (texts) { calls += texts.length; return embed.call(this, texts); };
`;

test("syncIndex after --build next: one embedding pass feeds BOTH slots; the next slot's catalog and FTS stay current", { timeout: 240_000 }, () => {
  // realpathSync: tmpdir() lives under a symlinked /var on macOS, and the
  // engine's own process.cwd() reports the canonical path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-sync-slots-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD_MOD}); console.log(JSON.stringify(await b.buildSlot({ name: "next" })));`);
    const dir = join(root, "memory", "entries", "2026", "01");
    writeFileSync(
      join(dir, "2026-01-09-penguin-rollout.md"),
      md({ id: "2026-01-09-penguin-rollout", date: "2026-01-09", type: "note", title: "Penguin rollout", people: [], teams: [], tags: ["rollout"] }, "penguin rollout body text"),
    );
    const nextDir = JSON.stringify(join(root, ".index", "slots", "next"));
    const r = runInStore(
      root,
      `${COUNT_ROWS}${COUNT_EMBEDS}
       const s = await import(${STORE_MOD});
       const sync = await s.syncIndex();
       const legacyChunks = await count(${JSON.stringify(join(root, ".index"))}, "memory");
       const nextChunks = await count(${nextDir}, "memory");
       const nextEntries = await count(${nextDir}, "entries");
       const { LanceCatalog } = await import(${JSON.stringify(join(REPO, "src", "catalog-lance.ts"))});
       const cat = await LanceCatalog.open({ slot: "next", dir: ${nextDir}, autoRefresh: false });
       const hits = await cat.lexical("penguin rollout", new Set(["2026-01-09-penguin-rollout"]), 10);
       console.log(JSON.stringify({ sync, calls, legacyChunks, nextChunks, nextEntries, hits }));`,
    ) as {
      sync: { added: number; slots: { slot: string; format: number; added: number }[] };
      calls: number;
      legacyChunks: number;
      nextChunks: number;
      nextEntries: number;
      hits: { id: string }[];
    };
    assert.equal(r.sync.added, 1);
    assert.deepEqual(r.sync.slots.map((s) => `${s.slot}:${s.format}:${s.added}`), ["legacy:1:1", "next:2:1"]);
    assert.equal(r.calls, 1, "the new chunk was embedded exactly once for both slots");
    assert.equal(r.legacyChunks, r.nextChunks, "both slots hold the same chunk rows");
    assert.equal(r.nextEntries, 8, "the next slot's catalog carries the new entry");
    assert.deepEqual(r.hits.map((h) => h.id), ["2026-01-09-penguin-rollout"], "FTS finds the un-indexed new row before optimize");
    const manifest = JSON.parse(readFileSync(join(root, ".index", "slots", "next", "catalog-manifest.json"), "utf8"));
    assert.equal(manifest.N, 8);
    assert.equal(manifest.generation, 2, "manifest generation advanced");
    assert.ok(!readFileSync(join(root, ".index", "lexical.json"), "utf8").includes('"format"'), "legacy lexical.json shape untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncIndex --rebuild on a format-2 active slot rebuilds the catalog without re-embedding", { timeout: 240_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-sync-rebuild-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD_MOD}); console.log(JSON.stringify(await b.buildSlot({ name: "next" })));`);
    const r = runInStore(
      root,
      `${COUNT_EMBEDS}
       const s = await import(${STORE_MOD});
       const sync = await s.syncIndex({ rebuild: true, slots: "active" });
       console.log(JSON.stringify({ sync, calls }));`,
      { MEMORY_INDEX_SLOT: "next" },
    ) as { sync: { slots: { slot: string }[]; unchanged: number }; calls: number };
    assert.deepEqual(r.sync.slots.map((s) => s.slot), ["next"], "slots: active syncs only the active slot");
    assert.equal(r.sync.unchanged, 7);
    assert.equal(r.calls, 0, "rebuild keeps every vector");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncIndex --rebuild on the legacy slot rebuilds lexical.json in place, without re-embedding", { timeout: 240_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-sync-legacy-rebuild-")));
  const lexicalPath = join(root, ".index", "lexical.json");
  const tombstones = (): number =>
    (JSON.parse(readFileSync(lexicalPath, "utf8")) as { docs: (unknown | null)[] }).docs.filter((d) => d === null).length;
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    // A deleted entry leaves a tombstone an incremental sync keeps; only a
    // rebuild clears it, so this is what distinguishes the two paths.
    rmSync(join(root, "memory", "entries", "2026", "01", "2026-01-03-otter-hiring.md"));
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);
    assert.equal(tombstones(), 1, "the incremental sync tombstoned the deleted entry");
    const r = runInStore(
      root,
      `${COUNT_EMBEDS}
       const s = await import(${STORE_MOD});
       const sync = await s.syncIndex({ rebuild: true });
       console.log(JSON.stringify({ sync, calls }));`,
    ) as { sync: { slots: { slot: string; format: number }[]; unchanged: number }; calls: number };
    assert.deepEqual(r.sync.slots.map((s) => `${s.slot}:${s.format}`), ["legacy:1"], "only the legacy slot exists");
    assert.equal(r.sync.unchanged, 6, "the surviving entries are untouched");
    assert.equal(r.calls, 0, "a legacy rebuild keeps every vector");
    assert.equal(tombstones(), 0, "the rebuilt lexical index carries no tombstones");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncIndex: a catalog version bump rebuilds the catalog tables and keeps every vector", { timeout: 240_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-sync-catalog-bump-")));
  const nextDir = join(root, ".index", "slots", "next");
  const metaPath = join(nextDir, "meta.json");
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD_MOD}); console.log(JSON.stringify(await b.buildSlot({ name: "next" })));`);

    // Corrupt one catalog row's pre-tokenized text while leaving its hash
    // alone: the version-blind incremental diff sees nothing to do, so only a
    // genuine drop-and-rebuild can restore it.
    runInStore(
      root,
      `const lancedb = await import(${LANCE});
       const db = await lancedb.connect(${JSON.stringify(nextDir)});
       const t = await db.openTable("entries");
       const [row] = await t.query().where("id = '2026-01-06-rare-codeword'").toArray();
       await t.delete("id = '2026-01-06-rare-codeword'");
       await t.add([{ ...row, lex: "zzzz" }]);
       console.log(JSON.stringify({ ok: true }));`,
    );
    const stale = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    writeFileSync(metaPath, `${JSON.stringify({ ...stale, catalogVersion: 0 }, null, 2)}\n`, "utf8");

    const r = runInStore(
      root,
      `${COUNT_EMBEDS}
       const s = await import(${STORE_MOD});
       const sync = await s.syncIndex();
       const lancedb = await import(${JSON.stringify(join(REPO, "node_modules", "@lancedb", "lancedb", "dist", "index.js"))});
       const db = await lancedb.connect(${JSON.stringify(nextDir)});
       const t = await db.openTable("entries");
       const [row] = await t.query().where("id = '2026-01-06-rare-codeword'").toArray();
       const chunks = await (await db.openTable("memory")).countRows();
       console.log(JSON.stringify({ sync, calls, lex: row.lex, entries: await t.countRows(), chunks }));`,
    ) as { sync: { slots: { slot: string }[] }; calls: number; lex: string; entries: number; chunks: number };

    assert.equal(r.calls, 0, "a catalog version bump never re-embeds");
    assert.ok(r.chunks > 0, "the vector table survived the catalog rebuild");
    assert.ok(!r.lex.includes("zzzz"), "the catalog row was rebuilt from the Markdown, not kept by the hash diff");
    assert.ok(r.lex.includes("codeword"), `the rebuilt row carries the real tokens, got: ${r.lex}`);
    assert.equal(r.entries, 7, "every entry is back in the catalog");
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { catalogVersion: number };
    assert.equal(meta.catalogVersion, 1, "meta.json records the current catalog version");
    const manifest = JSON.parse(readFileSync(join(nextDir, "catalog-manifest.json"), "utf8")) as { catalogVersion: number; N: number };
    assert.equal(manifest.catalogVersion, 1);
    assert.equal(manifest.N, 7);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncIndex: a broken non-active slot is reported, never fatal to the write", { timeout: 240_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-sync-broken-slot-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD_MOD}); console.log(JSON.stringify(await b.buildSlot({ name: "next" })));`);
    writeFileSync(join(root, ".index", "slots", "next", "meta.json"), "{ not json", "utf8");
    writeFileSync(
      join(root, "memory", "entries", "2026", "01", "2026-01-09-penguin-rollout.md"),
      md({ id: "2026-01-09-penguin-rollout", date: "2026-01-09", type: "note", title: "Penguin rollout", people: [], teams: [], tags: ["rollout"] }, "penguin rollout body text"),
    );
    const r = runInStore(
      root,
      `${COUNT_ROWS}
       const s = await import(${STORE_MOD});
       const sync = await s.syncIndex();
       const legacyChunks = await count(${JSON.stringify(join(root, ".index"))}, "memory");
       console.log(JSON.stringify({ sync, legacyChunks }));`,
    ) as { sync: { added: number; slots: { slot: string; error?: string }[] }; legacyChunks: number };

    assert.equal(r.sync.added, 1, "the active slot was synced");
    assert.equal(r.legacyChunks, 8, "the new entry reached the active slot's chunk table");
    assert.deepEqual(r.sync.slots.map((s) => s.slot), ["legacy", "next"], "the broken slot is still reported");
    assert.equal(r.sync.slots[0]!.error, undefined, "the active slot succeeded");
    assert.ok(r.sync.slots[1]!.error, "the broken slot carries its failure");
    assert.match(r.sync.slots[1]!.error!, /meta\.json/, `the message names what failed, got: ${r.sync.slots[1]!.error}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
