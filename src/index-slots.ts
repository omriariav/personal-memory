import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Index slots: `.index/` root = the legacy slot (today's files, never changed
 * in shape); `.index/slots/<name>/` = a complete self-contained new-format
 * index; `.index/active.json` names the active one (absent ⇒ legacy root).
 * Judgment sidecars always stay at the root, shared by every slot.
 *
 * Resolution is LAZY (a function, not a module constant) so `--index-slot`
 * parsed into MEMORY_INDEX_SLOT after the store module loaded still applies,
 * while the root itself is captured at load exactly like ingest.ts:15-19.
 */
export const INDEX_ROOT = join(process.cwd(), ".index");
export const LEGACY_SLOT = "legacy";
export const FRESH_SLOT = "main";
export const SLOTS_DIRNAME = "slots";
export const BUILDING_SUFFIX = "__building";
export const ACTIVE_FILENAME = "active.json";
export const META_FILENAME = "meta.json";
export const MANIFEST_FILENAME = "catalog-manifest.json";
export const CATALOG_VERSION = 1;

const SLOT_RE = /^[a-z0-9][a-z0-9-]*$/;
export const RESERVED_SLOT_NAMES: ReadonlySet<string> = new Set([LEGACY_SLOT, "previous"]);

/** Judgment sidecars: always at the .index/ root, shared by every slot, never pruned. */
export const PRESERVED_SIDECARS: readonly string[] = Object.freeze([
  "connector-state.json",
  "promotion-dismissals.json",
  "chain-dismissals.json",
  "slug-dismissals.json",
  "slug-proposals.json",
  "maintenance-state.json",
  "graph-maintenance.json",
  ACTIVE_FILENAME,
]);

/** Rebuildable artifacts of the legacy root slot — the only root paths `--prune` may delete. */
export const DERIVED_ARTIFACTS: readonly string[] = Object.freeze([
  "memory.lance",
  "memory_headers.lance",
  "lexical.json",
  "entries-cache.json",
  META_FILENAME,
]);

const slotName = z.string().regex(SLOT_RE, "must be a lower-kebab slot name");

export const ActiveFileSchema = z.object({ slot: slotName, previous: slotName.optional() }).strict();
export type ActiveFile = z.infer<typeof ActiveFileSchema>;

export const SlotMetaSchema = z
  .object({
    format: z.literal(2),
    indexVersion: z.number().int(),
    embedderId: z.string().min(1),
    dim: z.number().int().positive(),
    catalogVersion: z.number().int(),
    vectorIndex: z.enum(["flat"]),
    headerTable: z.boolean(),
    lexical: z.enum(["fts"]),
    builtAt: z.string().min(1),
  })
  .strict();
export type SlotMeta = z.infer<typeof SlotMetaSchema>;

export const CatalogManifestSchema = z
  .object({
    catalogVersion: z.number().int(),
    generation: z.number().int().nonnegative(),
    /** root-relative dir → mtimeMs (scanDirMtimes), for the read-path freshness check. */
    dirs: z.record(z.string(), z.number()),
    N: z.number().int().nonnegative(),
    avgdl: z.number().nonnegative(),
    syncedAt: z.string().min(1),
  })
  .strict();
export type CatalogManifest = z.infer<typeof CatalogManifestSchema>;

export type LegacyMeta = { format: 1; embedderId?: string; dim?: number; indexVersion?: number };
export type IndexMeta = LegacyMeta | SlotMeta;

export function isSlotName(name: unknown): name is string {
  return typeof name === "string" && SLOT_RE.test(name) && !name.endsWith(BUILDING_SUFFIX) && !RESERVED_SLOT_NAMES.has(name);
}

export function slotDir(slot: string, root: string = INDEX_ROOT): string {
  if (slot === LEGACY_SLOT) return root;
  if (!isSlotName(slot)) {
    throw new Error(`invalid index slot name '${slot}' — lower-kebab (a-z, 0-9, -), not 'legacy'/'previous', not ending in ${BUILDING_SUFFIX}`);
  }
  return join(root, SLOTS_DIRNAME, slot);
}

export function buildingDir(slot: string, root: string = INDEX_ROOT): string {
  return `${slotDir(slot, root)}${BUILDING_SUFFIX}`;
}

export function slotFormat(slot: string): 1 | 2 {
  return slot === LEGACY_SLOT ? 1 : 2;
}

export function readIndexMetaSync(dir: string): IndexMeta | null {
  const path = join(dir, META_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (data && data.format === 2) return SlotMetaSchema.parse(data);
  // Legacy shape: missing fields are defaults; never fail on an old file.
  const meta: LegacyMeta = { format: 1 };
  if (typeof data?.embedderId === "string") meta.embedderId = data.embedderId;
  if (typeof data?.dim === "number") meta.dim = data.dim;
  if (typeof data?.indexVersion === "number") meta.indexVersion = data.indexVersion;
  return meta;
}

export function readActiveSync(root: string = INDEX_ROOT): ActiveFile | null {
  const path = join(root, ACTIVE_FILENAME);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid ${path}: ${err instanceof Error ? err.message : String(err)} — delete it to fall back to the legacy root`);
  }
  const parsed = ActiveFileSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`invalid ${path}:\n` + parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"));
  }
  return parsed.data;
}

export async function writeActive(file: ActiveFile, root: string = INDEX_ROOT): Promise<string> {
  const parsed = ActiveFileSchema.parse(file);
  await mkdir(root, { recursive: true });
  const path = join(root, ACTIVE_FILENAME);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return path;
}

export function slotExists(slot: string, root: string = INDEX_ROOT): boolean {
  if (slot === LEGACY_SLOT) return true;
  if (!isSlotName(slot)) return false;
  return existsSync(join(slotDir(slot, root), META_FILENAME));
}

export type SlotSource = "override" | "env" | "active" | "previous" | "default";

export interface SlotResolution {
  slot: string;
  dir: string;
  format: 1 | 2;
  source: SlotSource;
  /** Set when active.json named a slot that is missing on disk (legacy fallback). */
  warning?: string;
}

/** `--index-slot` → MEMORY_INDEX_SLOT → active.json → the legacy root. */
export function resolveIndexSlotDetailed(
  opts: { override?: string; env?: Record<string, string | undefined>; root?: string } = {},
): SlotResolution {
  const root = opts.root ?? INDEX_ROOT;
  const env = opts.env ?? process.env;
  const active = readActiveSync(root);
  const explicit = opts.override || env.MEMORY_INDEX_SLOT || undefined;
  if (explicit !== undefined) {
    let name = explicit;
    let source: SlotSource = opts.override ? "override" : "env";
    if (name === "previous") {
      if (!active?.previous) throw new Error("no previous index slot is recorded in .index/active.json");
      name = active.previous;
      source = "previous";
    }
    if (name !== LEGACY_SLOT && !isSlotName(name)) {
      throw new Error(`invalid index slot name '${name}'`);
    }
    if (!slotExists(name, root)) {
      throw new Error(`unknown index slot '${name}' — build it with: npx tsx src/cli.ts index --build ${name}   (index slots lists what exists)`);
    }
    return { slot: name, dir: slotDir(name, root), format: slotFormat(name), source };
  }
  if (active) {
    if (slotExists(active.slot, root)) {
      return { slot: active.slot, dir: slotDir(active.slot, root), format: slotFormat(active.slot), source: "active" };
    }
    return {
      slot: LEGACY_SLOT,
      dir: root,
      format: 1,
      source: "default",
      warning: `active.json names slot '${active.slot}' which is missing on disk — using the legacy root index (rebuild with: npx tsx src/cli.ts index --build ${active.slot})`,
    };
  }
  return { slot: LEGACY_SLOT, dir: root, format: 1, source: "default" };
}

export function resolveIndexSlot(opts?: Parameters<typeof resolveIndexSlotDetailed>[0]): string {
  return resolveIndexSlotDetailed(opts).slot;
}

export function resolveIndexDir(opts?: Parameters<typeof resolveIndexSlotDetailed>[0]): string {
  return resolveIndexSlotDetailed(opts).dir;
}

export interface SlotInfo {
  name: string;
  dir: string;
  format: 1 | 2;
  /** meta.json present (a complete index). */
  built: boolean;
  /** A `<name>__building` directory (an interrupted build; discarded by the next build). */
  building: boolean;
  active: boolean;
  previous: boolean;
}

export function listSlots(root: string = INDEX_ROOT): SlotInfo[] {
  const active = readActiveSync(root);
  const current = active && slotExists(active.slot, root) ? active.slot : LEGACY_SLOT;
  const rows: SlotInfo[] = [
    {
      name: LEGACY_SLOT,
      dir: root,
      format: 1,
      built: existsSync(join(root, META_FILENAME)),
      building: false,
      active: current === LEGACY_SLOT,
      previous: active?.previous === LEGACY_SLOT,
    },
  ];
  const slotsDir = join(root, SLOTS_DIRNAME);
  if (existsSync(slotsDir)) {
    for (const ent of readdirSync(slotsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const building = ent.name.endsWith(BUILDING_SUFFIX);
      const name = building ? ent.name.slice(0, -BUILDING_SUFFIX.length) : ent.name;
      if (!isSlotName(name)) continue;
      rows.push({
        name,
        dir: join(slotsDir, ent.name),
        format: 2,
        built: !building && existsSync(join(slotsDir, ent.name, META_FILENAME)),
        building,
        active: !building && current === name,
        previous: !building && active?.previous === name,
      });
    }
  }
  const legacyRow = rows[0]!;
  const slotRows = rows.slice(1);
  slotRows.sort((a, b) => a.name.localeCompare(b.name));
  return [legacyRow, ...slotRows];
}

export function listBuiltSlots(root: string = INDEX_ROOT): SlotInfo[] {
  return listSlots(root).filter((s) => s.built);
}
