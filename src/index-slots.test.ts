import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DERIVED_ARTIFACTS,
  LEGACY_SLOT,
  PRESERVED_SIDECARS,
  isSlotName,
  listSlots,
  readActiveSync,
  readIndexMetaSync,
  resetResolutionWarning,
  resolveIndexSlotDetailed,
  slotDir,
  warnResolution,
  writeActive,
} from "./index-slots.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pm-slots-"));
}

function mkSlot(root: string, name: string, meta: Record<string, unknown> = { format: 2, indexVersion: 6, embedderId: "fake:hashed-bag", dim: 64, catalogVersion: 1, vectorIndex: "flat", headerTable: false, lexical: "fts", builtAt: "2026-10-01T00:00:00.000Z" }): void {
  mkdirSync(join(root, "slots", name), { recursive: true });
  writeFileSync(join(root, "slots", name, "meta.json"), JSON.stringify(meta));
}

test("resolution: an existing root index with no active.json and no env → the legacy root", () => {
  const root = tempRoot();
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "meta.json"), JSON.stringify({ embedderId: "fake:hashed-bag", dim: 64, indexVersion: 6 }));
    const r = resolveIndexSlotDetailed({ root, env: {} });
    assert.deepEqual(r, { slot: LEGACY_SLOT, dir: root, format: 1, source: "default" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: a store with no index at all defaults to the fresh new-format slot 'main'; a root meta.json means legacy", () => {
  const root = tempRoot();
  try {
    const fresh = resolveIndexSlotDetailed({ root, env: {} });
    assert.deepEqual([fresh.slot, fresh.format, fresh.source, fresh.dir], ["main", 2, "default", join(root, "slots", "main")]);
    writeFileSync(join(root, "meta.json"), JSON.stringify({ embedderId: "x", dim: 1, indexVersion: 6 }));
    assert.equal(resolveIndexSlotDetailed({ root, env: {} }).slot, LEGACY_SLOT);
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

test("resolution: 'previous' resolves active.previous; active.json pointing at a missing slot falls back to the DEFAULT slot with a warning", () => {
  const root = tempRoot();
  try {
    mkSlot(root, "next");
    writeFileSync(join(root, "meta.json"), JSON.stringify({ embedderId: "fake:hashed-bag", dim: 64, indexVersion: 6 }));
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "next", previous: "legacy" }));
    const prev = resolveIndexSlotDetailed({ root, env: {}, override: "previous" });
    assert.deepEqual([prev.slot, prev.source], [LEGACY_SLOT, "previous"]);
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "gone" }));
    const fallback = resolveIndexSlotDetailed({ root, env: {} });
    assert.equal(fallback.slot, LEGACY_SLOT, "a store WITH a legacy root index falls back to it");
    assert.match(fallback.warning ?? "", /active\.json names slot 'gone'/);
    assert.throws(() => resolveIndexSlotDetailed({ root, env: {}, override: "previous" }), /no previous index slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: the missing-slot fallback is defaultSlot, so a store with no legacy root lands on the fresh slot, not a format-1 root", () => {
  const root = tempRoot();
  try {
    // No root meta.json and no memory.lance: this store never had a legacy index.
    writeFileSync(join(root, "active.json"), JSON.stringify({ slot: "gone" }));
    const fallback = resolveIndexSlotDetailed({ root, env: {} });
    assert.deepEqual(
      [fallback.slot, fallback.format, fallback.dir],
      ["main", 2, join(root, "slots", "main")],
      "falling back to the legacy root here would give the store a format-1 index on its next write",
    );
    assert.match(fallback.warning ?? "", /names slot 'gone'.*using slot 'main'/s, "the warning names the slot actually used");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolution: warnResolution prints the warning to stderr once per process, and never under MEMORY_QUIET=1", () => {
  const lines: string[] = [];
  const realError = console.error;
  const realQuiet = process.env.MEMORY_QUIET;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    resetResolutionWarning();
    const r = { slot: "legacy", dir: "/x", format: 1 as const, source: "default" as const, warning: "active.json names slot 'gone'" };
    delete process.env.MEMORY_QUIET;
    warnResolution(r);
    warnResolution(r);
    assert.deepEqual(lines, ["⚠ active.json names slot 'gone'"], "printed exactly once");
    resetResolutionWarning();
    process.env.MEMORY_QUIET = "1";
    warnResolution(r);
    assert.equal(lines.length, 1, "MEMORY_QUIET=1 silences it");
    resetResolutionWarning();
    delete process.env.MEMORY_QUIET;
    warnResolution({ slot: "legacy", dir: "/x", format: 1, source: "default" });
    assert.equal(lines.length, 1, "a resolution with no warning prints nothing");
  } finally {
    console.error = realError;
    if (realQuiet === undefined) delete process.env.MEMORY_QUIET;
    else process.env.MEMORY_QUIET = realQuiet;
    resetResolutionWarning();
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
    // Index-less store: nothing is built, and the resolver's fresh default
    // ('main') has no row yet — so no row is the active one.
    assert.deepEqual(listSlots(root).map((s) => [s.name, s.built, s.active]), [[LEGACY_SLOT, false, false]]);
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

/**
 * The migration scripts decide what survives an index move from their OWN copy
 * of this list. Two lists, one rule: a sidecar added here and forgotten there
 * would be deleted by a migration. The shell array is read out of the file
 * rather than restated here, so this test cannot drift along with it.
 */
test("PRESERVED_SIDECARS and migration_lib.sh's DURABLE_INDEX_STATE_FILES name the same files", () => {
  const libPath = join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "migration_lib.sh");
  const block = /DURABLE_INDEX_STATE_FILES=\(([^)]*)\)/.exec(readFileSync(libPath, "utf8"));
  assert.ok(block, `no DURABLE_INDEX_STATE_FILES array in ${libPath}`);
  const shell = block[1]!
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean);
  assert.ok(shell.length > 1, `parsed only ${shell.length} entries out of the shell array — the regex stopped matching`);
  assert.deepEqual([...shell].sort(), [...PRESERVED_SIDECARS].sort(), "the two durable-sidecar lists must stay in step");
});
