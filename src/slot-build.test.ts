import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PRESERVED_SIDECARS } from "./index-slots.js";
import { REPO, STORE_MOD, md, runInStore, seedStore } from "./test-store.js";

const BUILD_MOD = JSON.stringify(join(REPO, "src", "slot-build.ts"));

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
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);
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
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);
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
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, headerLeg);
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
