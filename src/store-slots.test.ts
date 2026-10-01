import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECALL_MOD, STORE_MOD, runInStore, seedStore } from "./test-store.js";

test("store resolves the index dir per call: default = legacy root; an unknown MEMORY_INDEX_SLOT is a clear error", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-store-slots-"));
  try {
    seedStore(root);
    // The sync is pinned to the legacy slot (an index-less store would
    // otherwise take the fresh new-format default); the status read is NOT,
    // so it exercises the default resolution over the v6 root it just wrote.
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    const status = runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.indexStatus()));`) as {
      slot: string;
      format: number;
      indexedEntries: number;
    };
    assert.equal(status.slot, "legacy");
    assert.equal(status.format, 1);
    assert.equal(status.indexedEntries, 7);
    assert.ok(existsSync(join(root, ".index", "meta.json")), "legacy meta.json written at the root");
    assert.throws(
      () => runInStore(root, `const s = await import(${STORE_MOD}); await s.indexStatus();`, { MEMORY_INDEX_SLOT: "nope" }),
      /unknown index slot 'nope'/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const RECALL = `const { recall } = await import(${RECALL_MOD}); console.log(JSON.stringify(await recall(["budget review"], { now: ${Date.UTC(2026, 1, 1)} })));`;

test("a read never builds a slot: entries but no index is refused with the build command; syncIndex is what creates 'main'", { timeout: 180_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-unbuilt-read-")));
  try {
    seedStore(root);
    assert.throws(
      () => runInStore(root, RECALL),
      /no index built for slot "main" — run `npx tsx src\/cli\.ts index`/,
      "a recall against an unbuilt slot names the command that builds it",
    );
    assert.equal(existsSync(join(root, ".index", "slots")), false, "a refused read materializes nothing");

    // The write path is the only thing that creates the slot — and it records
    // the choice, so later reads resolve it from active.json.
    const sync = runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`) as {
      slots: { slot: string; format: number }[];
    };
    assert.deepEqual(
      sync.slots.map((s) => `${s.slot}:${s.format}`),
      ["main:2"],
      "a fresh store syncs into the new-format slot",
    );
    assert.deepEqual(JSON.parse(readFileSync(join(root, ".index", "active.json"), "utf8")), { slot: "main" });

    const report = runInStore(root, RECALL) as { index: { slot: string; format: number }; hits: { id: string }[] };
    assert.deepEqual(report.index, { slot: "main", format: 2 }, "the same recall now reads the built slot");
    assert.ok(report.hits.length > 0, `recall returns hits once the slot is built, got ${report.hits.length}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("optimizeIndex on a store whose active slot was never built creates no slot directory", { timeout: 120_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-optimize-unbuilt-")));
  try {
    seedStore(root);
    // Entries on disk, nothing indexed: the active slot resolves to `main`,
    // which does not exist. The weekly job must report on it, not create it.
    const r = runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.optimizeIndex()));`) as {
      tableExists: boolean;
      slots: { slot: string; format: number; fts: unknown }[];
    };
    assert.equal(r.tableExists, false, "there is no chunk table to compact");
    assert.deepEqual(r.slots.map((s) => [s.slot, s.format, s.fts]), [["main", 2, null]], "the unbuilt active slot is reported, not skipped");
    assert.equal(existsSync(join(root, ".index", "slots")), false, "and compacting it leaves no empty slots/ behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a store with no entries at all recalls to an empty report, not an error, and still creates nothing", { timeout: 120_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-empty-store-")));
  try {
    mkdirSync(join(root, "memory", "entries"), { recursive: true });
    const report = runInStore(root, RECALL) as {
      index: { slot: string; format: number };
      hits: unknown[];
      candidateCount: number;
    };
    assert.deepEqual(report.hits, [], "nothing to find");
    assert.equal(report.candidateCount, 0);
    assert.deepEqual(report.index, { slot: "main", format: 2 }, "the report still names the slot it would read");
    assert.equal(existsSync(join(root, ".index", "slots")), false, "an empty store's read builds nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
