import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chainAncestry } from "./chains.js";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

const MEMBERSHIP = JSON.stringify(join(REPO, "src", "membership.ts"));
const GM = JSON.stringify(join(REPO, "src", "graph-maintenance.ts"));
const BUILD = JSON.stringify(join(REPO, "src", "slot-build.ts"));

test("chainAncestry: walks follows transitively through the lookup, cycle-safe", async () => {
  const graph: Record<string, string[]> = { d: ["c"], c: ["b", "x"], b: ["a"], a: [], x: ["c"] };
  const lookup = async (ids: string[]) =>
    ids.filter((id) => id in graph).map((id) => ({ id, date: "2026-01-01", follows: graph[id] }));
  const got = await chainAncestry(lookup, ["d"]);
  assert.deepEqual(got.map((e) => e.id).sort(), ["a", "b", "c", "d", "x"], "every ancestor reached exactly once");
});

test("membership reads go through the catalog: an unbuilt format-2 slot refuses instead of parsing the corpus", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-membership-unbuilt-")));
  try {
    seedStore(root);
    const r = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       const g = await import(${GM});
       const fail = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
       console.log(JSON.stringify({
         copy: await fail(() => m.copyEntry({ id: "2026-01-03-otter-hiring", to: "team-x" })),
         remove: await fail(() => m.removeEntry("2026-01-02-quokka-budget")),
         link: await fail(() => g.applyChainLink({ laterId: "2026-01-06-rare-codeword", follows: ["2026-01-03-otter-hiring"] })),
         merge: await fail(() => g.mergeSlugs({ kind: "person", from: "chen-mizrahi", to: "chen-m", dryRun: true })),
       }));`,
    ) as Record<string, string | null>;
    for (const [op, message] of Object.entries(r)) {
      assert.match(message ?? "", /no index built for slot/, `${op} reads through openCatalog`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("copy/move/remove/link and slug merge work on a format-2 active slot (reads via the catalog, writes keep every slot in sync)", { timeout: 300_000 }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-membership-")));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); await s.syncIndex(); console.log("null");`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${BUILD}); await b.buildSlot({ name: "next" }); await b.activateSlot("next"); console.log("null");`);
    const r = runInStore(
      root,
      `const m = await import(${MEMBERSHIP});
       const g = await import(${GM});
       const copy = await m.copyEntry({ id: "2026-01-03-otter-hiring", to: "team-x" });
       const blocked = await m.copyEntry({ id: "2026-01-05-budget-decided", to: "team-x" });
       const link = await g.applyChainLink({ laterId: "2026-01-06-rare-codeword", follows: ["2026-01-03-otter-hiring"], refreshAudit: false });
       const removeBlocked = await m.removeEntry("2026-01-02-quokka-budget");
       const merge = await g.mergeSlugs({ kind: "person", from: "chen-mizrahi", to: "chen-m", createTarget: true, refreshAudit: false });
       const moved = await m.moveEntry({ id: "2026-01-03-otter-hiring", to: "default" });
       console.log(JSON.stringify({ copy, blocked, link, removeBlocked, merge, moved }));`,
    ) as Record<string, any>;
    assert.equal(r.copy.changed, true, "copy into team-x succeeded");
    assert.deepEqual(r.copy.index.slots.map((s: { slot: string }) => s.slot).sort(), ["legacy", "next"], "writers sync both slots");
    assert.deepEqual(r.blocked.blockedBy, ["2026-01-04-budget-pending"], "containment via catalog byIds");
    assert.equal(r.link.changed, true, "chain link written");
    assert.deepEqual(r.removeBlocked.blockedBy, ["summary-tag-budget"], "referrers via catalog");
    assert.equal(r.merge.affectedEntries, 1, "one entry carried the merged person slug");
    assert.equal(r.moved.changed, true, "move back to default succeeded");
    assert.equal(
      existsSync(join(root, "memory-graphs", "team-x", "entries", "2026", "01", "2026-01-03-otter-hiring.md")),
      false,
      "moved back out of team-x",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
