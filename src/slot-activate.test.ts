import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERIVED_ARTIFACTS, LEGACY_SLOT, PRESERVED_SIDECARS, readActiveSync } from "./index-slots.js";
import { activateSlot, pruneSlots, slotStatus } from "./slot-build.js";

const META2 = {
  format: 2,
  indexVersion: 6,
  embedderId: "fake:hashed-bag",
  dim: 64,
  catalogVersion: 1,
  vectorIndex: "flat",
  headerTable: false,
  lexical: "fts",
  builtAt: "2026-10-01T00:00:00.000Z",
};

/**
 * A `.index/` root holding: a legacy-format index (meta.json + its derived
 * artifacts), every judgment sidecar, two built new-format slots, and one
 * interrupted build. Nothing is a real Lance table — the counts are expected
 * to come back null rather than throw.
 */
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-activate-")));
  writeFileSync(join(root, "meta.json"), JSON.stringify({ embedderId: "fake:hashed-bag", dim: 64, indexVersion: 6 }));
  for (const d of ["memory.lance", "memory_headers.lance"]) {
    mkdirSync(join(root, d));
    writeFileSync(join(root, d, "data"), "x");
  }
  writeFileSync(join(root, "lexical.json"), "{}");
  writeFileSync(join(root, "entries-cache.json"), "{}");
  for (const f of PRESERVED_SIDECARS) if (f !== "active.json") writeFileSync(join(root, f), `{"sidecar":"${f}"}`);
  for (const name of ["next", "other"]) {
    mkdirSync(join(root, "slots", name, "entries.lance"), { recursive: true });
    writeFileSync(join(root, "slots", name, "meta.json"), JSON.stringify(META2));
  }
  mkdirSync(join(root, "slots", "stale__building"), { recursive: true });
  return root;
}

test("compat (d): activate next, then previous, round-trips; activation refuses unbuilt slots", async () => {
  const root = fixture();
  try {
    assert.deepEqual(await activateSlot("next", root), { active: { slot: "next", previous: LEGACY_SLOT }, changed: true });
    assert.deepEqual(readActiveSync(root), { slot: "next", previous: LEGACY_SLOT });
    assert.deepEqual((await activateSlot("next", root)).changed, false, "re-activating the active slot is a no-op");
    assert.deepEqual((await activateSlot("previous", root)).active, { slot: LEGACY_SLOT, previous: "next" });
    assert.deepEqual((await activateSlot("previous", root)).active, { slot: "next", previous: LEGACY_SLOT });
    await assert.rejects(activateSlot("missing", root), /unknown index slot 'missing'/);
    await assert.rejects(activateSlot("stale", root), /unknown index slot 'stale'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compat (d): prune plans without --confirm, refuses the active slot, deletes only derived artifacts", async () => {
  const root = fixture();
  try {
    await activateSlot("next", root);
    const plan = await pruneSlots({ confirm: false, root });
    assert.equal(plan.confirmed, false);
    assert.deepEqual(plan.removed.map((r) => r.slot).sort(), [LEGACY_SLOT, "other", "stale"]);
    assert.deepEqual(plan.kept, ["next"]);
    assert.ok(existsSync(join(root, "slots", "other", "meta.json")), "plan deletes nothing");

    const done = await pruneSlots({ confirm: true, root });
    assert.equal(done.confirmed, true);
    assert.equal(existsSync(join(root, "slots", "other")), false);
    assert.equal(existsSync(join(root, "slots", "stale__building")), false);
    for (const f of DERIVED_ARTIFACTS) assert.equal(existsSync(join(root, f)), false, `${f} removed from the legacy root`);
    for (const f of PRESERVED_SIDECARS) if (f !== "active.json") assert.equal(readFileSync(join(root, f), "utf8"), `{"sidecar":"${f}"}`, `${f} untouched`);
    assert.ok(existsSync(join(root, "slots", "next", "meta.json")), "active slot untouched");
    assert.deepEqual(readActiveSync(root), { slot: "next" }, "previous cleared because it was pruned");

    const again = await pruneSlots({ confirm: true, root });
    assert.deepEqual(again.removed, [], "nothing left to prune");
    await assert.rejects(activateSlot("previous", root), /no previous index slot/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune's only root-level candidates are disjoint from the judgment sidecars", () => {
  const overlap = DERIVED_ARTIFACTS.filter((f) => PRESERVED_SIDECARS.includes(f));
  assert.deepEqual(overlap, [], "no sidecar may ever appear in the list prune deletes from the legacy root");
});

test("prune keeps the legacy root whole while the legacy slot is the active one", async () => {
  const root = fixture();
  try {
    await activateSlot(LEGACY_SLOT, root);
    const r = await pruneSlots({ confirm: true, root });
    assert.deepEqual(r.kept, [LEGACY_SLOT]);
    assert.deepEqual(r.removed.map((x) => x.slot).sort(), ["next", "other", "stale"]);
    for (const f of DERIVED_ARTIFACTS) assert.ok(existsSync(join(root, f)), `${f} kept — the legacy index is still in use`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("slotStatus lists every slot with its counts where readable", async () => {
  const root = fixture();
  try {
    const rows = await slotStatus(root);
    assert.deepEqual(
      rows.map((r) => `${r.name}:${r.format}:${r.built ? "built" : "-"}:${r.building ? "building" : "-"}:${r.active ? "active" : "-"}`),
      ["legacy:1:built:-:active", "next:2:built:-:-", "other:2:built:-:-", "stale:2:-:building:-"],
    );
    assert.equal(rows[0]!.chunks, null, "an unreadable table reports null rather than throwing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
