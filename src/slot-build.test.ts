import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PRESERVED_SIDECARS } from "./index-slots.js";
import { BUILD_BATCH_ENTRIES, defaultBuildName } from "./slot-build.js";
import { REPO, STORE_MOD, md, runInStore, seedStore } from "./test-store.js";

const BUILD_MOD = JSON.stringify(join(REPO, "src", "slot-build.ts"));

/**
 * The seeding sync is pinned to `MEMORY_INDEX_SLOT=legacy`: these tests are
 * about a new-format slot built BESIDE today's root index, and an index-less
 * store would otherwise take the fresh new-format default.
 */

/** sha256 of every file under dir (recursive, sorted), skipping `skip` subdirs. */
function treeHash(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      const rel = relative(dir, p);
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (ent.isDirectory()) walk(p);
      else out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/** An embedder wrapper that counts how many texts were embedded; same id as FakeEmbedder so vectors are reusable. */
const COUNTING_EMBEDDER = `
  const { FakeEmbedder } = await import(${JSON.stringify(join(REPO, "src", "embed.ts"))});
  const inner = new FakeEmbedder();
  let embeddedTexts = 0;
  const embedder = { id: inner.id, dim: inner.dim, embed: async (texts) => { embeddedTexts += texts.length; return inner.embed(texts); } };
`;

test("index --build next: reuses every vector, leaves the root slot untouched, preserves sidecars, is a no-op on re-run", { timeout: 240_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-build-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    const indexRoot = join(root, ".index");
    for (const f of PRESERVED_SIDECARS) if (f !== "active.json") writeFileSync(join(indexRoot, f), `{"sidecar":"${f}"}`);
    const before = treeHash(indexRoot, ["slots"]);

    const dry = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", dryRun: true, embedder }); console.log(JSON.stringify({ r, embeddedTexts }));`) as { r: Record<string, unknown>; embeddedTexts: number };
    assert.equal(dry.r.dryRun, true);
    assert.equal(dry.embeddedTexts, 0, "dry run never embeds");
    assert.equal(existsSync(join(indexRoot, "slots")), false, "dry run writes nothing");

    const built = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", embedder }); console.log(JSON.stringify({ r, embeddedTexts }));`) as { r: Record<string, number>; embeddedTexts: number };
    assert.equal(built.r.entries, 7);
    assert.equal(built.r.embedded, 0, "existing chunk vectors are copied by (id, hash)");
    assert.equal(built.r.vectorsReused, built.r.chunks);
    assert.equal(built.embeddedTexts, 0);
    assert.equal(built.r.embedded, built.embeddedTexts, "the reported embed count is the embedder's actual call count");
    assert.equal(built.r.headers, 0, "header leg is dormant by default");
    assert.deepEqual(treeHash(indexRoot, ["slots"]), before, "root slot and sidecars byte-identical");
    const slotDir = join(indexRoot, "slots", "next");
    assert.ok(existsSync(join(slotDir, "meta.json")), "meta.json written");
    assert.equal(JSON.parse(readFileSync(join(slotDir, "meta.json"), "utf8")).format, 2);
    assert.ok(existsSync(join(slotDir, "catalog-manifest.json")), "manifest written");
    assert.ok(existsSync(join(slotDir, "entries.lance")), "entries table");
    assert.ok(existsSync(join(slotDir, "files.lance")), "files table");
    assert.ok(existsSync(join(slotDir, "memory.lance")), "chunk table");
    assert.equal(existsSync(join(indexRoot, "slots", "next__building")), false, "build dir renamed away");
    assert.equal(existsSync(join(indexRoot, "active.json")), false, "build never activates");

    const slotBefore = treeHash(slotDir);
    const again = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", embedder }); console.log(JSON.stringify(r));`) as Record<string, unknown>;
    assert.equal(again.skipped, "already-built");
    assert.deepEqual(treeHash(slotDir), slotBefore, "re-run changes nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index --build: a build that dies mid-way leaves only <slot>__building, which the next build discards", { timeout: 240_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-build-kill-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    // one NEW entry, so the build must embed something — the throwing embedder dies there
    writeFileSync(join(root, "memory", "entries", "2026", "01", "2026-01-08-new-after-sync.md"), md({ id: "2026-01-08-new-after-sync", date: "2026-01-08", type: "note", title: "New after sync", people: [], teams: [], tags: [] }, "fresh body"));
    assert.throws(
      () => runInStore(root, `const { FakeEmbedder } = await import(${JSON.stringify(join(REPO, "src", "embed.ts"))}); const inner = new FakeEmbedder(); const embedder = { id: inner.id, dim: inner.dim, embed: async () => { throw new Error("killed"); } }; const b = await import(${BUILD_MOD}); await b.buildSlot({ name: "next", embedder });`),
      /killed/,
    );
    assert.equal(existsSync(join(root, ".index", "slots", "next")), false, "no complete slot");
    assert.ok(existsSync(join(root, ".index", "slots", "next__building")), "partial build left in __building");
    const ok = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", embedder }); console.log(JSON.stringify({ r, embeddedTexts }));`) as { r: Record<string, number>; embeddedTexts: number };
    assert.equal(ok.r.entries, 8);
    assert.equal(ok.r.embedded, 1, "only the new entry's chunk was embedded");
    assert.equal(ok.embeddedTexts, 1);
    assert.equal(ok.r.embedded, ok.embeddedTexts, "the reported embed count is the embedder's actual call count");
    assert.equal(ok.r.chunks, (ok.r.vectorsReused ?? 0) + ok.embeddedTexts, "every other chunk kept its vector");
    assert.equal(existsSync(join(root, ".index", "slots", "next__building")), false, "partial dir discarded");
    assert.ok(statSync(join(root, ".index", "slots", "next", "meta.json")).isFile(), "complete slot present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index --build: with the header leg enabled, header rows are written and their vectors reused too", { timeout: 240_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-build-headers-")));
  const headerLeg = { MEMORY_RANK_HEADER_LEG_WEIGHT: "1" };
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { ...headerLeg, MEMORY_INDEX_SLOT: "legacy" });
    const built = runInStore(
      root,
      `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ name: "next", embedder }); console.log(JSON.stringify({ r, embeddedTexts }));`,
      headerLeg,
    ) as { r: Record<string, number>; embeddedTexts: number };
    assert.equal(built.r.headers, 7, "one header row per entry");
    assert.equal(built.embeddedTexts, 0, "header vectors are reused by (id, hash) like chunk vectors");
    const slotDir = join(root, ".index", "slots", "next");
    assert.ok(existsSync(join(slotDir, "memory_headers.lance")), "header table written");
    assert.equal(JSON.parse(readFileSync(join(slotDir, "meta.json"), "utf8")).headerTable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index --build: a corpus larger than one write batch lands every row, still re-embedding nothing", { timeout: 600_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-build-batch-")));
  const headerLeg = { MEMORY_RANK_HEADER_LEG_WEIGHT: "1" };
  try {
    // One more entry than a batch holds, so the table is created from the
    // first batch and the rest arrive through `add`.
    const n = BUILD_BATCH_ENTRIES + 20;
    const entries = Array.from({ length: n }, (_, i) => ({
      id: `2026-02-${String((i % 28) + 1).padStart(2, "0")}-batch-${String(i).padStart(4, "0")}`,
      date: `2026-02-${String((i % 28) + 1).padStart(2, "0")}`,
      type: "note",
      title: `Batch note ${i}`,
      body: `short body number ${i}`,
    }));
    seedStore(root, entries);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { ...headerLeg, MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const s = await import(${STORE_MOD}); let r; do { r = await s.backfillHeaders({ batch: 2000 }); } while (r.remaining > 0); console.log(JSON.stringify(r));`, { ...headerLeg, MEMORY_INDEX_SLOT: "legacy" });

    const out = runInStore(
      root,
      `${COUNTING_EMBEDDER}
       const b = await import(${BUILD_MOD});
       const r = await b.buildSlot({ name: "next", embedder });
       const rows = {};
       for (const t of ["memory", "memory_headers", "entries"]) rows[t] = await b.countSlotRows(r.dir, t);
       console.log(JSON.stringify({ r, embeddedTexts, rows }));`,
      headerLeg,
    ) as { r: Record<string, number>; embeddedTexts: number; rows: Record<string, number> };

    assert.equal(out.r.entries, n, "every entry is in the build");
    assert.ok(out.r.chunks > BUILD_BATCH_ENTRIES, `the build must span more than one batch (chunks=${out.r.chunks})`);
    assert.equal(out.rows.memory, out.r.chunks, "the chunk table holds exactly the reported rows — no batch dropped");
    assert.equal(out.rows.memory_headers, out.r.headers, "the header table holds exactly the reported rows");
    assert.equal(out.r.headers, n, "one header row per entry across batches");
    assert.equal(out.rows.entries, n, "the catalog table holds one row per entry");
    assert.equal(out.r.embedded, 0, "batching must not lose the reuse map — nothing is re-embedded");
    assert.equal(out.embeddedTexts, 0, "and the embedder was never called");
    assert.equal(out.r.vectorsReused, out.r.chunks, "every chunk vector was copied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultBuildName: 'main' only on a store with no index at all, 'next' once there is one to build beside", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-build-default-")));
  try {
    const indexRoot = join(root, ".index");
    assert.equal(defaultBuildName(indexRoot), "main", "no .index/ at all");
    mkdirSync(indexRoot, { recursive: true });
    assert.equal(defaultBuildName(indexRoot), "main", "an .index/ with no meta.json is not a built index");
    writeFileSync(join(indexRoot, "meta.json"), JSON.stringify({ embedderId: "fake", dim: 8, indexVersion: 6 }));
    assert.equal(defaultBuildName(indexRoot), "next", "the legacy root is built");

    const fresh = realpathSync(mkdtempSync(join(tmpdir(), "pm-build-default2-")));
    try {
      const slot = join(fresh, ".index", "slots", "alpha");
      mkdirSync(slot, { recursive: true });
      assert.equal(defaultBuildName(join(fresh, ".index")), "main", "a slot dir without meta.json is still unbuilt");
      writeFileSync(join(slot, "meta.json"), JSON.stringify({ format: 2, indexVersion: 6, embedderId: "fake", dim: 8, catalogVersion: 1, vectorIndex: "flat", headerTable: false, lexical: "fts", builtAt: "2026-01-01T00:00:00.000Z" }));
      assert.equal(defaultBuildName(join(fresh, ".index")), "next", "a built slot counts even with no legacy root");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index --build with no slot name builds 'next' beside the existing index", { timeout: 240_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-build-noname-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    const built = runInStore(root, `${COUNTING_EMBEDDER} const b = await import(${BUILD_MOD}); const r = await b.buildSlot({ embedder }); console.log(JSON.stringify(r));`) as Record<string, unknown>;
    assert.equal(built.slot, "next", "defaults to 'next' when the legacy root is already built");
    assert.ok(existsSync(join(root, ".index", "slots", "next", "meta.json")), "slot built under its default name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index --build rejects reserved and invalid names", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-build-names-")));
  try {
    seedStore(root);
    for (const bad of ["legacy", "previous", "Next", "x__building"]) {
      assert.throws(() => runInStore(root, `const b = await import(${BUILD_MOD}); await b.buildSlot({ name: ${JSON.stringify(bad)} });`), /slot name/, bad);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
