import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addGoldenCase, goldenPaths, nextGoldenId, readGolden, writeGolden } from "./golden.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pm-golden-"));
}

test("goldenPaths: everything lives under <store>/eval/", () => {
  const p = goldenPaths("/store");
  assert.equal(p.dir, "/store/eval");
  assert.equal(p.golden, "/store/eval/golden.json");
  assert.equal(p.baseline, "/store/eval/baseline.json");
  assert.equal(p.lastRun, "/store/eval/last-run.json");
});

test("readGolden: no file → no cases", async () => {
  const dir = scratch();
  try {
    assert.deepEqual(await readGolden(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeGolden/readGolden round-trip, atomic file, version 1", async () => {
  const dir = scratch();
  try {
    const cases = addGoldenCase([], {
      query: "where did we land on the vendor",
      phrasings: ["vendor decision"],
      filters: { person: "jane-doe" },
      expect: ["2026-01-01-vendor-decision"],
      mustNotOutrank: [["2025-12-01-vendor-pending", "2026-01-01-vendor-decision"]],
      notes: "confirmed by user",
    });
    const path = await writeGolden(cases, dir);
    assert.equal(path, goldenPaths(dir).golden);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.version, 1);
    assert.deepEqual(await readGolden(dir), cases);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readGolden rejects a malformed file instead of silently dropping cases", async () => {
  const dir = scratch();
  try {
    mkdirSync(goldenPaths(dir).dir, { recursive: true });
    writeFileSync(goldenPaths(dir).golden, JSON.stringify({ version: 1, cases: [{ id: "g-001", bogus: true }] }));
    await assert.rejects(readGolden(dir), /invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nextGoldenId: zero-padded, continues after the highest existing id", () => {
  assert.equal(nextGoldenId([]), "g-001");
  const cases = addGoldenCase(addGoldenCase([], { query: "a", expect: ["x"] }), { query: "b", expect: ["y"] });
  assert.deepEqual(cases.map((c) => c.id), ["g-001", "g-002"]);
  assert.equal(nextGoldenId([{ ...cases[0]!, id: "g-007" }]), "g-008");
});

test("addGoldenCase: kind is golden, ids are assigned, and a case with no assertion is refused", () => {
  const [c] = addGoldenCase([], { query: "q", expect: ["x"] });
  assert.equal(c!.kind, "golden");
  assert.equal(c!.id, "g-001");
  assert.throws(() => addGoldenCase([], { query: "q", expect: [] }), /nothing to assert/);
  assert.doesNotThrow(() => addGoldenCase([], { query: "q", expect: [], expectAbsent: ["z"] }));
  assert.throws(() => addGoldenCase([], { query: "  ", expect: ["x"] }), /query/);
});
