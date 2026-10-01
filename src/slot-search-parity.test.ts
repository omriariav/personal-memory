import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, RECALL_MOD, STORE_MOD, normalizeReport, runInStore, seedStore } from "./test-store.js";

/**
 * Compatibility pin (spec Phase 3 verification (c)): the same store read
 * through a new-format slot returns what the legacy slot returns. With the
 * legacy ranking profile and the reference postings scorer the reports are
 * IDENTICAL; with the FTS lexical leg the k1 difference may reorder near-ties,
 * so there the hit sets (and the top hit) are what must agree.
 */
const BUILD_MOD = JSON.stringify(join(REPO, "src", "slot-build.ts"));
const NOW = Date.UTC(2026, 1, 1);
const QUERIES = [
  { positionals: ["otter hiring loop"], opts: { k: 5 } },
  { positionals: ["budget review", "spending forecasts"], opts: { filters: { person: "boris-cohen" }, k: 10 } },
  { positionals: ["zebra migration"], opts: { filters: { graph: "team-x" }, k: 5 } },
  { positionals: ["codeword zephyr"], opts: { k: 3, completeness: "none" } },
  { positionals: ["freeze approved"], opts: { k: 10 } },
];

function recallAll(root: string, env: Record<string, string>): { index: { slot: string }; hits: { id: string }[] }[] {
  const reports = runInStore(
    root,
    `const { recall } = await import(${RECALL_MOD});
     const out = [];
     for (const q of ${JSON.stringify(QUERIES)}) out.push(await recall(q.positionals, { ...q.opts, now: ${NOW} }));
     console.log(JSON.stringify(out));`,
    env,
  );
  return normalizeReport(reports, root) as never;
}

function stripIndex(reports: { index?: unknown }[]): unknown[] {
  return reports.map(({ index: _i, ...rest }) => rest);
}

/** Seed, sync the legacy root, then build `next` beside it from the same Markdown. */
function twoSlotStore(prefix: string): string {
  // realpathSync: tmpdir() lives under a symlinked /var on macOS, and the
  // engine's own process.cwd() reports the canonical path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  seedStore(root);
  runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
  runInStore(root, `const b = await import(${BUILD_MOD}); console.log(JSON.stringify(await b.buildSlot({ name: "next" })));`);
  return root;
}

test("compat (c): --index-slot next with the legacy profile and the postings scorer is identical to the legacy slot", { timeout: 300_000 }, () => {
  const root = twoSlotStore("pm-parity-");
  try {
    const legacy = recallAll(root, { MEMORY_INDEX_SLOT: "legacy", MEMORY_RANK_PROFILE: "legacy" });
    const next = recallAll(root, { MEMORY_INDEX_SLOT: "next", MEMORY_RANK_PROFILE: "legacy", MEMORY_LEXICAL: "postings" });
    assert.deepEqual(
      legacy.map((r) => r.index.slot),
      ["legacy", "legacy", "legacy", "legacy", "legacy"],
    );
    assert.deepEqual(
      next.map((r) => r.index.slot),
      ["next", "next", "next", "next", "next"],
    );
    assert.deepEqual(stripIndex(next), stripIndex(legacy));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compat (c): with the FTS lexical leg (default on next) the hit sets agree and the top hit is the same", { timeout: 300_000 }, () => {
  const root = twoSlotStore("pm-parity-fts-");
  try {
    const legacy = recallAll(root, { MEMORY_INDEX_SLOT: "legacy" });
    const next = recallAll(root, { MEMORY_INDEX_SLOT: "next" });
    for (let i = 0; i < QUERIES.length; i++) {
      const a = legacy[i]!.hits.map((h) => h.id);
      const b = next[i]!.hits.map((h) => h.id);
      assert.equal(b[0], a[0], `top hit for ${QUERIES[i]!.positionals[0]}`);
      const overlap = a.filter((id) => b.includes(id)).length / Math.max(a.length, b.length, 1);
      assert.ok(overlap >= 0.8, `overlap ${overlap} for ${QUERIES[i]!.positionals[0]}: ${a} vs ${b}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
