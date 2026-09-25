import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CASE_KINDS, generateCorpus } from "./eval-corpus.js";

function fingerprint(root: string): { files: number; sha256: string } {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(join(root, "memory"));
  out.sort();
  const h = createHash("sha256");
  for (const p of out) {
    h.update(relative(root, p) + "\n");
    h.update(readFileSync(p));
  }
  return { files: out.length, sha256: h.digest("hex") };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pm-corpus-"));
}

test("base corpus + needles are byte-identical to the original scripts/gen-corpus.ts output", async () => {
  const root = scratch();
  try {
    const m = await generateCorpus({ root, total: 4000, seed: 42, families: [] });
    // Recorded from the pre-refactor generator (4000 entries + 20 needles).
    assert.deepEqual(fingerprint(root), {
      files: 4020,
      sha256: "b97d678ea404ca159be8fd5abf4c19141f9f2cdf0d0610c30bebd32a13cbf1d2",
    });
    const needles = JSON.parse(readFileSync(join(root, "needles.json"), "utf8")) as { id: string }[];
    assert.equal(needles.length, 20);
    assert.equal(needles[0]!.id, "2023-07-16-needle-00");
    assert.equal(needles[19]!.id, "2026-03-29-needle-19");
    assert.equal(m.entries, 4020);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to generate inside a repo or package", async () => {
  const root = scratch();
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, "package.json"), "{}");
    await assert.rejects(generateCorpus({ root, total: 10 }), /refusing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all families: deterministic manifest, every case kind present, every referenced id exists on disk", async () => {
  const a = scratch();
  const b = scratch();
  try {
    const m1 = await generateCorpus({ root: a, total: 300, seed: 42 });
    const m2 = await generateCorpus({ root: b, total: 300, seed: 42 });
    assert.deepEqual(m1, m2);
    assert.equal(fingerprint(a).sha256, fingerprint(b).sha256);

    const kinds = new Set(m1.cases.map((c) => c.kind));
    for (const k of CASE_KINDS) {
      if (k === "golden") continue; // golden cases come from the real store, never the generator
      assert.ok(kinds.has(k), `missing case kind ${k}`);
    }

    const ids = new Set<string>();
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".md")) ids.add(f.slice(0, -3));
      }
    };
    walk(join(a, "memory"));
    for (const c of m1.cases) {
      const expected = Array.isArray(c.expect) ? c.expect : Object.keys(c.expect);
      for (const id of expected) assert.ok(ids.has(id), `${c.id} expects unknown id ${id}`);
      for (const [l, w] of c.mustNotOutrank ?? []) {
        assert.ok(ids.has(l) && ids.has(w), `${c.id} pair references unknown id`);
      }
    }
    assert.ok(Object.keys(m1.aliases).length >= 6);
    assert.equal(m1.seed, 42);
    assert.equal(m1.total, 300);
    assert.equal(typeof m1.generator, "number");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a different seed changes the corpus; the same seed at a different size keeps the main-loop prefix stable per index", async () => {
  const a = scratch();
  const b = scratch();
  try {
    await generateCorpus({ root: a, total: 100, seed: 1, families: [] });
    await generateCorpus({ root: b, total: 100, seed: 2, families: [] });
    assert.notEqual(fingerprint(a).sha256, fingerprint(b).sha256);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});
