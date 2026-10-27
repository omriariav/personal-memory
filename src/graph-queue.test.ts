import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueRowSchema } from "./graph-queue.js";
import { REPO, runInStore, seedStore } from "./test-store.js";

/**
 * The review queue. A row is a proposal and nothing more — the only thing
 * that publishes is an approval. Most of what matters here is reconciliation:
 * rows carry no status, so every read re-decides which are still live.
 */

const Q = JSON.stringify(join(REPO, "src", "graph-queue.ts"));
const M = JSON.stringify(join(REPO, "src", "membership.ts"));
const STORE = JSON.stringify(join(REPO, "src", "store.ts"));
const ID = "2026-01-03-otter-hiring";
const OTHER = "2026-01-02-quokka-budget";

function withStore(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-queue-")));
  try {
    seedStore(root);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const queueFile = (root: string) => join(root, "memory", "graphs", "queue.json");

/**
 * Run a script with graph-queue as `q` and membership as `m`, against a
 * freshly indexed store — several of these call read paths that refuse on an
 * unbuilt slot, which is a property of the harness, not of the queue.
 */
function inStore(root: string, script: string): unknown {
  return runInStore(
    root,
    `await (await import(${STORE})).syncIndex();
     const q = await import(${Q}); const m = await import(${M}); ${script}`,
  );
}

// --- schema -------------------------------------------------------------

test("a row cannot target the default graph", () => {
  const row = {
    id: ID, graph: "default", action: "copy", bodyHash: "0".repeat(16),
    reason: "r", proposedBy: "test", proposedAt: "2026-01-01T00:00:00Z",
  };
  const res = QueueRowSchema.safeParse(row);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error?.issues), /every entry's home/);
});

test("a move row cannot carry a summary", () => {
  // A move deletes the private home; a variant exists to diverge from one.
  const row = {
    id: ID, graph: "team-x", action: "move", bodyHash: "0".repeat(16),
    summary: "redacted", reason: "r", proposedBy: "test", proposedAt: "2026-01-01T00:00:00Z",
  };
  const res = QueueRowSchema.safeParse(row);
  assert.equal(res.success, false);
  assert.match(JSON.stringify(res.error?.issues), /no private home to diverge from/);
});

// --- enqueue ------------------------------------------------------------

test("enqueue stores a proposal without publishing anything", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `console.log(JSON.stringify(
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "fits the criteria", proposedBy: "test" })));`) as { queued: boolean };
    assert.equal(res.queued, true);
    assert.equal(
      existsSync(join(root, "memory-graphs", "team-x", "entries", "2026", "01", `${ID}.md`)),
      false,
      "queuing is not publishing",
    );
    assert.match(readFileSync(queueFile(root), "utf8"), /fits the criteria/);
  });
});

test("enqueue is keyed on (id, graph) and says when it overwrote a draft", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "first", proposedBy: "a", summary: "drafted words" });
      const second = await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "second", proposedBy: "b" });
      const file = await q.readQueue();
      console.log(JSON.stringify({ second, rows: file.rows.length, reason: file.rows[0].reason }));`) as
      { second: { replaced: boolean; replacedSummary: boolean }; rows: number; reason: string };
    assert.equal(res.rows, 1, "one row per (id, graph), not two");
    assert.equal(res.reason, "second");
    assert.equal(res.second.replaced, true);
    assert.equal(res.second.replacedSummary, true, "losing a drafted redaction is worth reporting");
  });
});

test("enqueue refuses rather than throws, so a sweep keeps going", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `console.log(JSON.stringify(await q.enqueueMany([
      { id: "no-such-entry", graph: "team-x", reason: "r", proposedBy: "t" },
      { id: "2026-01-01-zebra-migration", graph: "team-x", reason: "r", proposedBy: "t" },
      { id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" },
    ])));`) as { queued: boolean; refusal?: string }[];
    assert.equal(res[0]!.queued, false);
    assert.match(String(res[0]!.refusal), /no entry with id/);
    assert.equal(res[1]!.queued, false, "zebra is already a team-x member");
    assert.match(String(res[1]!.refusal), /already a member/);
    assert.equal(res[2]!.queued, true, "and the batch still got to the third");
  });
});

test("enqueue refuses an entry the user already declined at this content", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      const p = await import(${JSON.stringify(join(REPO, "src", "promote.ts"))});
      await p.dismissPromotion(${JSON.stringify(ID)}, "team-x", "not for them");
      const plain = await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" });
      const forced = await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t", force: true });
      console.log(JSON.stringify({ plain, forced }));`) as
      { plain: { queued: boolean; refusal?: string }; forced: { queued: boolean } };
    assert.equal(res.plain.queued, false);
    assert.match(String(res.plain.refusal), /already declined/);
    assert.equal(res.forced.queued, true, "--force is the way to re-propose deliberately");
  });
});

// --- reconciliation -----------------------------------------------------

test("a row drops out once the entry is a member, by any route", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" });
      await m.copyEntry({ id: ${JSON.stringify(ID)}, to: "team-x" });   // copied by hand, not approved
      const view = await q.queueView();
      console.log(JSON.stringify({ pending: view.totalPending, rows: (await q.readQueue()).rows.length }));`) as
      { pending: number; rows: number };
    assert.equal(res.pending, 0, "reconciliation notices it landed another way");
    assert.equal(res.rows, 0, "and the drop is persisted, since rows carry bodies");
  });
});

test("a row drops out when the user declines the entry", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      const p = await import(${JSON.stringify(join(REPO, "src", "promote.ts"))});
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" });
      await p.dismissPromotion(${JSON.stringify(ID)}, "team-x");
      console.log(JSON.stringify({ pending: (await q.queueView()).totalPending }));`) as { pending: number };
    assert.equal(res.pending, 0);
  });
});

test("a summary drafted against older words is flagged stale, not dropped", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      const i = await import(${JSON.stringify(join(REPO, "src", "ingest.ts"))});
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t", summary: "a redaction" });
      // Rewrite the home body behind the draft's back.
      const s = await import(${JSON.stringify(join(REPO, "src", "store.ts"))});
      const c = await import(${JSON.stringify(join(REPO, "src", "catalog.ts"))});
      const entry = (await (await c.openCatalog()).hydrate(await (await c.openCatalog()).byIds([${JSON.stringify(ID)}])))[0];
      const { body, path, graphs, paths, variants, ...fm } = entry;
      await i.writeEntry(fm, "completely different wording now", "default");
      await s.syncIndex();
      const view = await q.queueView();
      console.log(JSON.stringify({ pending: view.totalPending, state: view.rows[0] && view.rows[0].state }));`) as
      { pending: number; state: string };
    assert.equal(res.pending, 1, "the proposal is still live");
    assert.equal(res.state, "stale", "but its drafted words no longer match the entry");
  });
});

test("a plain copy proposal does not go stale on a body edit", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      const i = await import(${JSON.stringify(join(REPO, "src", "ingest.ts"))});
      const s = await import(${JSON.stringify(join(REPO, "src", "store.ts"))});
      const c = await import(${JSON.stringify(join(REPO, "src", "catalog.ts"))});
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" });
      const entry = (await (await c.openCatalog()).hydrate(await (await c.openCatalog()).byIds([${JSON.stringify(ID)}])))[0];
      const { body, path, graphs, paths, variants, ...fm } = entry;
      await i.writeEntry(fm, "different wording now", "default");
      await s.syncIndex();
      const view = await q.queueView();
      console.log(JSON.stringify({ state: view.rows[0] && view.rows[0].state }));`) as { state: string };
    // Nothing was drafted against the old words, so there is nothing to re-read.
    assert.equal(res.state, "ready");
  });
});

test("a row whose refs are outside the graph is kept and marked blocked", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      await q.enqueue({ id: "2026-01-05-budget-decided", graph: "team-x", reason: "r", proposedBy: "t" });
      const view = await q.queueView({ graph: "team-x" });
      console.log(JSON.stringify({ pending: view.totalPending, blockedBy: view.rows[0].blockedBy, blocked: view.graphs[0].blocked }));`) as
      { pending: number; blockedBy: string[]; blocked: number };
    assert.equal(res.pending, 1, "it stays queued — you can copy the parent and come back");
    assert.deepEqual(res.blockedBy, ["2026-01-04-budget-pending"]);
    assert.equal(res.blocked, 1);
  });
});

// --- decisions ----------------------------------------------------------

test("approving raw copies the entry's own wording and clears the row", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t", summary: "a redaction" });
      const r = await q.approveCandidate({ id: ${JSON.stringify(ID)}, graph: "team-x", variant: "raw" });
      console.log(JSON.stringify({ r, pending: (await q.queueView()).totalPending }));`) as
      { r: { variantOf?: string }; pending: number };
    assert.equal(res.r.variantOf, undefined, "raw means no variant is declared");
    assert.equal(res.pending, 0);
    const published = readFileSync(join(root, "memory-graphs", "team-x", "entries", "2026", "01", `${ID}.md`), "utf8");
    assert.match(published, /interviews and offers/);
    assert.doesNotMatch(published, /variant_of_hash/);
  });
});

test("approving the summary publishes the redaction and declares it", { timeout: 300_000 }, () => {
  withStore((root) => {
    inStore(root, `
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t", summary: "Only the shareable gist." });
      console.log(JSON.stringify(await q.approveCandidate({ id: ${JSON.stringify(ID)}, graph: "team-x", variant: "summary" })));`);
    const published = readFileSync(join(root, "memory-graphs", "team-x", "entries", "2026", "01", `${ID}.md`), "utf8");
    assert.match(published, /Only the shareable gist/);
    assert.doesNotMatch(published, /interviews and offers/, "the private wording stayed private");
    assert.match(published, /variant_of_hash: [0-9a-f]{16}/);
  });
});

test("approving a summary that was never drafted is refused, not silently raw", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" });
      try {
        await q.approveCandidate({ id: ${JSON.stringify(ID)}, graph: "team-x", variant: "summary" });
        console.log(JSON.stringify({ threw: false }));
      } catch (e) { console.log(JSON.stringify({ threw: true, name: e.constructor.name })); }`) as
      { threw: boolean; name?: string };
    assert.equal(res.threw, true);
    assert.equal(res.name, "UnknownCandidateError");
    assert.equal(
      existsSync(join(root, "memory-graphs", "team-x", "entries", "2026", "01", `${ID}.md`)),
      false,
      "and nothing was published",
    );
  });
});

test("approving a blocked row is refused with its blockers named", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      await q.enqueue({ id: "2026-01-05-budget-decided", graph: "team-x", reason: "r", proposedBy: "t" });
      try {
        await q.approveCandidate({ id: "2026-01-05-budget-decided", graph: "team-x", variant: "raw" });
        console.log(JSON.stringify({ threw: false }));
      } catch (e) { console.log(JSON.stringify({ threw: true, name: e.constructor.name, blockedBy: e.blockedBy })); }`) as
      { threw: boolean; name?: string; blockedBy?: string[] };
    assert.equal(res.threw, true);
    assert.equal(res.name, "BlockedCandidateError");
    assert.deepEqual(res.blockedBy, ["2026-01-04-budget-pending"]);
  });
});

test("approving twice is refused the second time, never a double copy", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" });
      await q.approveCandidate({ id: ${JSON.stringify(ID)}, graph: "team-x", variant: "raw" });
      try {
        await q.approveCandidate({ id: ${JSON.stringify(ID)}, graph: "team-x", variant: "raw" });
        console.log(JSON.stringify({ threw: false }));
      } catch (e) { console.log(JSON.stringify({ threw: true, name: e.constructor.name })); }`) as
      { threw: boolean; name?: string };
    assert.equal(res.threw, true, "double-clicks are the normal case, not the edge case");
    assert.equal(res.name, "UnknownCandidateError");
  });
});

test("declining records the no and clears the row", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      const p = await import(${JSON.stringify(join(REPO, "src", "promote.ts"))});
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" });
      await q.dismissCandidate({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "too detailed" });
      console.log(JSON.stringify({
        pending: (await q.queueView()).totalPending,
        dismissals: (await p.readPromotionDismissals()).map((d) => [d.id, d.graph, d.reason]),
      }));`) as { pending: number; dismissals: string[][] };
    assert.equal(res.pending, 0);
    assert.deepEqual(res.dismissals, [[ID, "team-x", "too detailed"]]);
  });
});

// --- per-graph progress -------------------------------------------------

test("a decision advances only its own graph's progress", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      const g = await import(${JSON.stringify(join(REPO, "src", "graphs.ts"))});
      await g.createGraph({ slug: "team-y" });
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-x", reason: "r", proposedBy: "t" });
      await q.enqueue({ id: ${JSON.stringify(OTHER)}, graph: "team-y", reason: "r", proposedBy: "t" });
      await q.approveCandidate({ id: ${JSON.stringify(ID)}, graph: "team-x", variant: "raw" });
      const view = await q.queueView();
      const by = Object.fromEntries(view.graphs.map((x) => [x.graph, x]));
      console.log(JSON.stringify({
        xReviewed: Boolean(by["team-x"].lastReviewedAt), yReviewed: Boolean(by["team-y"].lastReviewedAt),
        xPending: by["team-x"].pending, yPending: by["team-y"].pending }));`) as
      { xReviewed: boolean; yReviewed: boolean; xPending: number; yPending: number };
    assert.equal(res.xReviewed, true);
    assert.equal(res.yReviewed, false, "each queue's progress is its own");
    assert.equal(res.xPending, 0);
    assert.equal(res.yPending, 1);
  });
});

test("the sweep watermark never moves backwards by accident", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      await q.markSwept("team-x", { through: "2026-03-01" });
      let refused = false;
      try { await q.markSwept("team-x", { through: "2026-01-01" }); } catch { refused = true; }
      const forced = await q.markSwept("team-x", { through: "2026-01-01", force: true });
      console.log(JSON.stringify({ refused, forced: forced.sweptThrough }));`) as
      { refused: boolean; forced: string };
    assert.equal(res.refused, true, "re-running an older window must not erase progress");
    assert.equal(res.forced, "2026-01-01");
  });
});

test("deleting a graph drops its pending rows", { timeout: 300_000 }, () => {
  withStore((root) => {
    const res = inStore(root, `
      const g = await import(${JSON.stringify(join(REPO, "src", "graphs.ts"))});
      await g.createGraph({ slug: "team-y" });
      await q.enqueue({ id: ${JSON.stringify(ID)}, graph: "team-y", reason: "r", proposedBy: "t" });
      const del = await m.deleteGraph("team-y");
      console.log(JSON.stringify({ removed: del.queueRowsRemoved, rows: (await q.readQueue()).rows.length }));`) as
      { removed: number; rows: number };
    assert.equal(res.removed, 1);
    assert.equal(res.rows, 0);
  });
});
