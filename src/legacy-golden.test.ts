import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, RECALL_MOD, STORE_MOD, normalizeReport, runInStore, seedStore } from "./test-store.js";

/**
 * Compatibility pin (spec Phase 3 verification (a) + (f)): on a store whose
 * `.index/` has no active.json, recall output must stay byte-identical to the
 * output recorded before index slots existed, under both ranking profiles.
 * Re-record ONLY when a deliberate output change ships: UPDATE_GOLDEN=1.
 */
const FIXTURE = join(REPO, "src", "fixtures", "legacy-golden.json");
const NOW = Date.UTC(2026, 1, 1);

const QUERIES: { positionals: string[]; opts: Record<string, unknown> }[] = [
  { positionals: ["otter hiring loop"], opts: { k: 5 } },
  { positionals: ["budget review", "spending forecasts"], opts: { filters: { person: "boris-cohen" }, k: 10 } },
  { positionals: ["zebra migration"], opts: { filters: { graph: "team-x" }, k: 5 } },
  { positionals: ["codeword zephyr"], opts: { k: 3, completeness: "none" } },
];

function record(root: string): unknown {
  const out: Record<string, unknown> = {};
  for (const profile of ["current", "legacy"]) {
    out[profile] = runInStore(
      root,
      `const { recall } = await import(${RECALL_MOD});
       const queries = ${JSON.stringify(QUERIES)};
       const reports = [];
       for (const q of queries) reports.push(await recall(q.positionals, { ...q.opts, now: ${NOW} }));
       console.log(JSON.stringify(reports));`,
      { MEMORY_RANK_PROFILE: profile },
    );
  }
  return normalizeReport(out, root);
}

test("legacy slot: recall output is byte-identical to the recorded golden under both profiles", { timeout: 180_000 }, () => {
  // realpathSync: on macOS, tmpdir() lives under a symlinked /var, so the
  // engine's own process.cwd() (which getcwd() canonicalizes) reports a
  // "/private/..." path. Resolving here keeps normalizeReport's substring
  // replace exact, instead of leaving a stray "/private" prefix behind.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-golden-")));
  try {
    seedStore(root);
    const sync = runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`) as { added: number };
    assert.equal(sync.added, 7);
    assert.equal(existsSync(join(root, ".index", "active.json")), false, "a plain sync never writes active.json");
    assert.equal(existsSync(join(root, ".index", "slots")), false, "a plain sync never creates slots/");
    const actual = record(root);
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    }
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(actual, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
