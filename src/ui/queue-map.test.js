// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MOTES,
  laneRows,
  laneY,
  moteDrift,
  moteSlot,
  nodeRadius,
  parseGraphsHash,
  queueMapHeight,
  queueSourceLabel,
  relativeDate,
} from "./queue-map.js";

/**
 * The lane map's maths and its view model — the parts that decide whether
 * anything is legible, and whether a URL lands where it should. The SVG
 * itself is checked by eye.
 */

/** @param {Partial<import("./queue-map.js").QueueLane> & {graph: string}} l */
const lane = (l) => ({ pending: 0, blocked: 0, stale: 0, members: 0, ...l });

test("queueMapHeight grows with the lane count and never collapses", () => {
  assert.ok(queueMapHeight(0) > 0, "an empty registry still frames something");
  assert.equal(queueMapHeight(0), queueMapHeight(1), "zero lanes reserve one lane's room");
  assert.ok(queueMapHeight(4) > queueMapHeight(2));
});

test("laneY spaces lanes evenly and clears the top", () => {
  assert.ok(laneY(0) > 0);
  const gap = laneY(1) - laneY(0);
  assert.ok(gap > 0);
  assert.equal(laneY(5) - laneY(4), gap, "evenly spaced, so the eye can scan down");
});

test("nodeRadius scales by root and never becomes a dot", () => {
  assert.ok(nodeRadius(0, 100) >= 20, "an empty graph is still a disc");
  assert.ok(nodeRadius(100, 100) > nodeRadius(10, 100));
  // Square-rooted: 100x smaller is not 100x smaller on screen.
  assert.ok(nodeRadius(1, 100) > nodeRadius(100, 100) * 0.5);
  assert.equal(nodeRadius(5, 0), 20, "no members anywhere — fall back, do not divide by zero");
  assert.equal(nodeRadius(500, 100), nodeRadius(100, 100), "clamped at the max");
});

test("moteSlot queues candidates back from the gate without leaving the lane", () => {
  const k = 5;
  const xs = Array.from({ length: k }, (_, i) => moteSlot(i, k));
  for (let i = 1; i < k; i++) assert.ok(xs[i] < xs[i - 1], "each waits behind the last");
  assert.ok(Math.min(...xs) > 140, "and none runs back past the hub");
});

test("moteSlot compresses rather than overflowing when the queue is full", () => {
  const full = Array.from({ length: MAX_MOTES }, (_, i) => moteSlot(i, 400));
  for (let i = 1; i < full.length; i++) assert.ok(full[i] < full[i - 1]);
  assert.ok(Math.min(...full) > 140, "a 400-deep queue still fits — the gate's number carries it");
});

test("moteDrift is bounded, staggered, and still at t=0", () => {
  assert.equal(moteDrift(0, 0, 0), 0, "a reduced-motion render sits on the lane");
  for (const t of [0.4, 1, 2.5, 9]) {
    for (const i of [0, 3]) assert.ok(Math.abs(moteDrift(t, i, 0)) <= 3.3);
  }
  assert.notEqual(moteDrift(2, 0, 0), moteDrift(2, 0, 1), "lanes do not pulse in unison");
  assert.notEqual(moteDrift(2, 0, 0), moteDrift(2, 1, 0), "nor do motes within a lane");
});

test("relativeDate reads today, yesterday, days, weeks and never", () => {
  const now = new Date("2026-03-15T12:00:00Z");
  assert.equal(relativeDate(undefined, now), "never");
  assert.equal(relativeDate("nonsense", now), "never");
  assert.equal(relativeDate("2026-03-15T09:00:00Z", now), "today");
  assert.equal(relativeDate("2026-03-14T09:00:00Z", now), "yesterday");
  assert.equal(relativeDate("2026-03-10T12:00:00Z", now), "5d ago");
  assert.equal(relativeDate("2026-03-01T12:00:00Z", now), "2w ago");
  assert.equal(relativeDate("2026-01-01T12:00:00Z", now), "2mo ago");
  assert.equal(relativeDate("2024-01-01T12:00:00Z", now), "2y ago");
});

test("queueSourceLabel names a rule, an explicit capture and a routine", () => {
  assert.equal(queueSourceLabel("rules", "copy"), "standing rule");
  assert.equal(queueSourceLabel("add", "copy"), "you, at capture");
  assert.equal(queueSourceLabel("codex-nightly", "copy"), "routine · codex-nightly");
  assert.match(queueSourceLabel("rules", "move"), /→ move/, "a move is worth saying out loud");
});

test("laneRows marks an empty lane and lights the selected one", () => {
  const rows = laneRows(
    [lane({ graph: "team-x", pending: 3, members: 12 }), lane({ graph: "quiet", members: 4 })],
    "quiet",
  );
  assert.equal(rows[0].empty, false);
  assert.equal(rows[0].lit, false);
  assert.equal(rows[1].empty, true, "nothing pending — drawn dashed and dimmed");
  assert.equal(rows[1].lit, true);
});

test("laneRows caps the motes it asks for but keeps the true count", () => {
  const [row] = laneRows([lane({ graph: "busy", pending: 240, members: 9 })], "");
  assert.equal(row.pending, 240, "the gate shows the real number");
  assert.equal(row.motes, MAX_MOTES, "the lane draws at most a readable few");
});

test("laneRows labels a lane with members and when it was last touched", () => {
  const now = new Date("2026-03-15T12:00:00Z");
  const [row] = laneRows(
    [lane({ graph: "team-x", members: 1, lastReviewedAt: "2026-03-14T10:00:00Z", sweptThrough: "2026-03-01", sweptAt: "2026-03-01T10:00:00Z" })],
    "",
    now,
  );
  assert.match(row.label, /1 member ·/, "singular, not '1 members'");
  assert.match(row.label, /reviewed yesterday/);
  assert.match(row.label, /swept 2w ago/);
});

test("laneRows says never swept when no routine has run", () => {
  const [row] = laneRows([lane({ graph: "team-x", members: 3 })], "");
  assert.match(row.label, /reviewed never/);
  assert.match(row.label, /swept never/);
});

test("laneRows takes staleness from the server, not its own clock", () => {
  const fresh = laneRows([lane({ graph: "a", members: 1, stale: 0 })], "")[0];
  const stale = laneRows([lane({ graph: "a", members: 1, stale: 2 })], "")[0];
  assert.equal(fresh.stale, false);
  assert.equal(stale.stale, true);
});

test("parseGraphsHash maps every tab shape", () => {
  assert.deepEqual(parseGraphsHash("#/graphs"), { kind: "tab", tab: "graphs", slug: "" });
  assert.deepEqual(parseGraphsHash("#/graphs/"), { kind: "tab", tab: "graphs", slug: "" });
  assert.deepEqual(parseGraphsHash("#/graphs/rules"), { kind: "tab", tab: "rules", slug: "" });
  assert.deepEqual(parseGraphsHash("#/graphs/queue"), { kind: "tab", tab: "queue", slug: "" });
  assert.deepEqual(parseGraphsHash("#/graphs/queue/team-x"), { kind: "tab", tab: "queue", slug: "team-x" });
});

test("parseGraphsHash leaves a graph slug as its manifest, including one starting with 'queue'", () => {
  assert.deepEqual(parseGraphsHash("#/graphs/team-x"), { kind: "manifest", slug: "team-x" });
  // The whole reason this is an exact-segment parse.
  assert.deepEqual(parseGraphsHash("#/graphs/queue-archive"), { kind: "manifest", slug: "queue-archive" });
  assert.deepEqual(parseGraphsHash("#/graphs/rules-of-thumb"), { kind: "manifest", slug: "rules-of-thumb" });
});

test("parseGraphsHash decodes slugs and ignores other routes", () => {
  assert.deepEqual(parseGraphsHash("#/graphs/queue/a%2Fb"), { kind: "tab", tab: "queue", slug: "a/b" });
  assert.equal(parseGraphsHash("#/graph/team-x"), null, "the singular entries-graph route is not ours");
  assert.equal(parseGraphsHash("#/maintenance"), null);
  assert.equal(parseGraphsHash(""), null);
});
