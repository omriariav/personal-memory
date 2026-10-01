import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DERIVED_ARTIFACTS,
  LEGACY_SLOT,
  PRESERVED_SIDECARS,
  isSlotName,
  listSlots,
  readActiveSync,
  readIndexMetaSync,
  resolveIndexSlotDetailed,
  slotDir,
  writeActive,
} from "./index-slots.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pm-slots-"));
}

function mkSlot(root: string, name: string, meta: Record<string, unknown> = { format: 2, indexVersion: 6, embedderId: "fake:hashed-bag", dim: 64, catalogVersion: 1, vectorIndex: "flat", headerTable: false, lexical: "fts", builtAt: "2026-10-01T00:00:00.000Z" }): void {
  mkdirSync(join(root, "slots", name), { recursive: true });
  writeFileSync(join(root, "slots", name, "meta.json"), JSON.stringify(meta));
}

test("resolution: no active.json and no env → the legacy root", () => {
  const root = tempRoot();
  try {
    const r = resolveIndexSlotDetailed({ root, env: {} });
    assert.deepEqual(r, { slot: LEGACY_SLOT, dir: root, format: 1, source: "default" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: env names a slot that is not built → clear error naming the build command", () => {
  const root = tempRoot();
  try {
    assert.throws(() => resolveIndexSlotDetailed({ root, env: { MEMORY_INDEX_SLOT: "nope" } }), /unknown index slot 'nope'.*index --build nope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: override beats env beats active.json; all resolve to the slot dir", () => {
  const root = tempRoot();
  try {
    mkSlot(root, "next");
    mkSlot(root, "other");
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "next" }));
    assert.equal(resolveIndexSlotDetailed({ root, env: {} }).source, "active");
    assert.equal(resolveIndexSlotDetailed({ root, env: {} }).dir, join(root, "slots", "next"));
    const viaEnv = resolveIndexSlotDetailed({ root, env: { MEMORY_INDEX_SLOT: "other" } });
    assert.deepEqual([viaEnv.slot, viaEnv.source], ["other", "env"]);
    const viaFlag = resolveIndexSlotDetailed({ root, env: { MEMORY_INDEX_SLOT: "other" }, override: LEGACY_SLOT });
    assert.deepEqual([viaFlag.slot, viaFlag.dir, viaFlag.format, viaFlag.source], [LEGACY_SLOT, root, 1, "override"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: 'previous' resolves active.previous; active.json pointing at a missing slot falls back to legacy with a warning", () => {
  const root = tempRoot();
  try {
    mkSlot(root, "next");
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "next", previous: "legacy" }));
    const prev = resolveIndexSlotDetailed({ root, env: {}, override: "previous" });
    assert.deepEqual([prev.slot, prev.source], [LEGACY_SLOT, "previous"]);
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "gone" }));
    const fallback = resolveIndexSlotDetailed({ root, env: {} });
    assert.equal(fallback.slot, LEGACY_SLOT);
    assert.match(fallback.warning ?? "", /active\.json names slot 'gone'/);
    assert.throws(() => resolveIndexSlotDetailed({ root, env: {}, override: "previous" }), /no previous index slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active.json: atomic write round-trips; a corrupt file throws instead of silently picking a slot", async () => {
  const root = tempRoot();
  try {
    assert.equal(readActiveSync(root), null);
    const path = await writeActive({ slot: "next", previous: LEGACY_SLOT }, root);
    assert.equal(path, join(root, "active.json"));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { slot: "next", previous: LEGACY_SLOT });
    assert.deepEqual(readActiveSync(root), { slot: "next", previous: LEGACY_SLOT });
    writeFileSync(path, "{not json");
    assert.throws(() => readActiveSync(root), /active\.json/);
    await assert.rejects(writeActive({ slot: "Bad Name" } as never, root), /slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listSlots: legacy row reflects meta.json presence; built, building and active/previous flags", () => {
  const root = tempRoot();
  try {
    assert.deepEqual(listSlots(root).map((s) => [s.name, s.built, s.active]), [[LEGACY_SLOT, false, true]]);
    writeFileSync(join(root, "meta.json"), JSON.stringify({ embedderId: "fake:hashed-bag", dim: 64, indexVersion: 6 }));
    mkSlot(root, "next");
    mkdirSync(join(root, "slots", "later__building"), { recursive: true });
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "next", previous: LEGACY_SLOT }));
    const rows = listSlots(root).map((s) => `${s.name}:${s.format}:${s.built ? "built" : "-"}:${s.building ? "building" : "-"}:${s.active ? "active" : "-"}:${s.previous ? "prev" : "-"}`);
    assert.deepEqual(rows, ["legacy:1:built:-:-:prev", "later:2:-:building:-:-", "next:2:built:-:active:-"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readIndexMetaSync: a corrupt meta.json throws a labeled error instead of a raw SyntaxError", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "slots", "broken"), { recursive: true });
    const metaPath = join(root, "slots", "broken", "meta.json");
    writeFileSync(metaPath, "{not json");
    assert.throws(() => readIndexMetaSync(join(root, "slots", "broken")), new RegExp(`invalid ${metaPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("names: slotDir maps legacy to the root and rejects invalid or reserved names", () => {
  assert.equal(slotDir(LEGACY_SLOT, "/r/.index"), "/r/.index");
  assert.equal(slotDir("next", "/r/.index"), "/r/.index/slots/next");
  assert.throws(() => slotDir("Next", "/r/.index"), /invalid index slot name/);
  assert.throws(() => slotDir("x__building", "/r/.index"), /invalid index slot name/);
  assert.equal(isSlotName("previous"), false);
  assert.ok(PRESERVED_SIDECARS.includes("active.json"), "active.json is a preserved sidecar");
  assert.ok(DERIVED_ARTIFACTS.every((f) => !PRESERVED_SIDECARS.includes(f)), "derived and preserved sets are disjoint");
});
