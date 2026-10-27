import { test } from "node:test";
import assert from "node:assert/strict";
import { MOTE_PERIOD, SPIN_RATE, moteAt, motePhase, ringPos } from "./graphs-map.js";

// The animation loop itself needs requestAnimationFrame and a visible tab, so
// the motion is pinned here as maths: these are the functions the frame loop
// calls, and they are what decides whether anything actually moves.

test("ringPos turns the ring over time and comes back round", () => {
  const a = ringPos(0, 0);
  const b = ringPos(0, 10);
  assert.notDeepEqual(a, b, "ten seconds in, a graph has moved");

  // a full turn returns it to where it started
  const period = (2 * Math.PI) / SPIN_RATE;
  const back = ringPos(0, period);
  assert.ok(Math.abs(back.x - a.x) < 1e-6 && Math.abs(back.y - a.y) < 1e-6);
  assert.ok(period > 120, "a turn takes over two minutes, so it never chases the eye");
});

test("ringPos spaces graphs around a vertically squashed ring", () => {
  const east = ringPos(0, 0);
  const west = ringPos(Math.PI, 0);
  const south = ringPos(Math.PI / 2, 0);
  assert.ok(east.x > west.x, "opposite slots land on opposite sides");
  assert.equal(east.y.toFixed(6), west.y.toFixed(6), "and at the same height");
  // squashed: the vertical reach is half the horizontal
  const dx = Math.abs(east.x - west.x) / 2;
  const dy = Math.abs(south.y - east.y);
  assert.ok(dy < dx, "the ring is flatter than it is wide");
});

test("motePhase cycles once per period and staggers the two motes", () => {
  assert.equal(motePhase(0, 0, 0), 0);
  assert.ok(Math.abs(motePhase(MOTE_PERIOD / 2, 0, 0) - 0.5) < 1e-9);
  assert.ok(motePhase(MOTE_PERIOD, 0, 0) < 1e-9, "a full period wraps back to the start");
  assert.equal(motePhase(0, 1, 0), 0.5, "the second mote runs half a period behind");
  assert.notEqual(motePhase(0, 0, 1.2), motePhase(0, 0, 0), "spokes do not pulse in unison");
});

test("moteAt runs from the hub to the satellite and fades at both ends", () => {
  const to = { x: 800, y: 300 };
  const start = moteAt(to.x, to.y, 0);
  const mid = moteAt(to.x, to.y, 0.5);
  const end = moteAt(to.x, to.y, 1);

  // the run begins at the hub and ends on the satellite
  assert.ok(Math.abs(start.x - 490) < 1e-6, "starts at the hub");
  assert.ok(Math.abs(end.x - to.x) < 1e-6 && Math.abs(end.y - to.y) < 1e-6, "arrives at the satellite");
  assert.ok(mid.x > start.x && mid.x < end.x, "and travels between them");

  // invisible at both ends, brightest in the middle
  assert.ok(start.opacity < 0.01);
  assert.ok(end.opacity < 0.01);
  assert.ok(mid.opacity > 0.8);
});

test("moteAt eases rather than tracking at constant speed", () => {
  const to = { x: 900, y: 200 };
  const atQuarter = moteAt(to.x, to.y, 0.25).x;
  const atHalf = moteAt(to.x, to.y, 0.5).x;
  const linearQuarter = 490 + (to.x - 490) * 0.25;
  assert.ok(atQuarter < linearQuarter, "slower than linear leaving the hub");
  assert.ok(Math.abs(atHalf - (490 + (to.x - 490) * 0.5)) < 1e-6, "and symmetric at the midpoint");
});
