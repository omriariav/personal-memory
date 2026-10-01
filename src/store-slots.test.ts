import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_MOD, runInStore, seedStore } from "./test-store.js";

test("store resolves the index dir per call: default = legacy root; an unknown MEMORY_INDEX_SLOT is a clear error", { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-store-slots-"));
  try {
    seedStore(root);
    const status = runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex(); console.log(JSON.stringify(await s.indexStatus()));`) as { slot: string; format: number; indexedEntries: number };
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
