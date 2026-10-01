import { indexStatus } from "./store.js";
import { lexicalStatus } from "./lexical.js";
import { openCatalog, type CatalogEntryMeta } from "./catalog.js";
import { resolveIndexSlotDetailed } from "./index-slots.js";
import { NEXT_SLOT, formatSlotTable, slotStatus, type SlotStatusRow } from "./slot-build.js";
import { analyzeGraphHygiene, readSlugDismissals, readSlugProposals, slugDismissalKeys, writeGraphMaintenanceAudit } from "./graph-maintenance.js";
import { buildChainIndex } from "./chains.js";

/**
 * Read-only hygiene report: digest debt (scopes with many unsummarized raw
 * entries → suggested `memory digest` commands), index health, and slug
 * hygiene (likely-duplicate people/team slugs). Never writes anything — and
 * in particular never builds or syncs a slot: it reports what is on disk.
 */

/** The store size past which running on the legacy index is worth a nudge. */
export const SLOT_HINT_ENTRIES = 2000;

/**
 * One line when the store is large and nothing but the legacy format exists.
 * A format-2 slot that is merely half-built does not count: the hint is about
 * there being an index in the new format to try, not a directory.
 */
export function slotHint(rows: SlotStatusRow[], entries: number): string | null {
  if (entries <= SLOT_HINT_ENTRIES) return null;
  if (rows.some((r) => r.format === 2 && r.built)) return null;
  return (
    `hint: ${entries} entries — build the next-format index: npx tsx src/cli.ts index --build ${NEXT_SLOT},` +
    ` try it with --index-slot ${NEXT_SLOT}, then --activate ${NEXT_SLOT}`
  );
}

interface Scope {
  kind: "person" | "quarter" | "tag";
  key: string;
  uncovered: number;
}

function quarterOf(date: string): string {
  const [y, m] = date.split("-");
  return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
}

function digestDebt(entries: CatalogEntryMeta[], threshold: number): Scope[] {
  const raw = entries.filter((e) => e.type !== "summary");
  // Every raw entry already cited by some summary's `sources` is "covered".
  const covered = new Set(
    entries.filter((e) => e.type === "summary").flatMap((e) => e.sources ?? []),
  );
  const uncovered = raw.filter((e) => !covered.has(e.id));

  const counts = new Map<string, Scope>();
  const bump = (kind: Scope["kind"], key: string) => {
    const mapKey = `${kind}:${key}`;
    const s = counts.get(mapKey) ?? { kind, key, uncovered: 0 };
    s.uncovered++;
    counts.set(mapKey, s);
  };
  for (const e of uncovered) {
    for (const p of e.people) bump("person", p);
    for (const t of e.tags) bump("tag", t);
    bump("quarter", quarterOf(e.date));
  }
  return [...counts.values()]
    .filter((s) => s.uncovered >= threshold)
    .sort((a, b) => b.uncovered - a.uncovered);
}

export async function runMaintenance(threshold: number): Promise<void> {
  const catalog = await openCatalog();
  const entries = await catalog.all();

  console.log("## Digest debt");
  const debt = digestDebt(entries, threshold);
  if (debt.length === 0) {
    console.log(`(no scope has ≥${threshold} unsummarized entries)`);
  } else {
    for (const s of debt) {
      const flag = s.kind === "person" ? "--person" : s.kind === "tag" ? "--tag" : "--quarter";
      console.log(
        `npx tsx src/cli.ts digest ${flag} ${s.key}   # ${s.uncovered} unsummarized entries`,
      );
    }
  }

  console.log("\n## Index health");
  const idx = await indexStatus();
  console.log(
    `entries ${idx.totalEntries} · indexed ${idx.indexedEntries} · stale ${idx.staleEntries} · missing ${idx.missingEntries} · chunks ${idx.chunkRows} (${idx.embedderId ?? "no index"})`,
  );
  // `lexical.json` is the format-1 lexical leg. A new-format slot indexes its
  // text with FTS inside the catalog, so reporting the root file as "missing"
  // there would be a permanent false alarm.
  const lex = idx.format === 1 ? await lexicalStatus() : null;
  const lexStale = idx.format === 1 && (!lex || lex.docs !== idx.totalEntries);
  if (idx.format === 1) console.log(lex ? `lexical: ${lex.docs} docs, ${lex.terms} terms` : "lexical: (missing)");
  if (idx.staleEntries + idx.missingEntries > 0 || lexStale) {
    console.log("→ fix: npx tsx src/cli.ts index");
  }
  const { headerLegEnabled, headerStatus } = await import("./store.js");
  if (headerLegEnabled()) {
    const hs = await headerStatus();
    console.log(`headers: ${hs.headers}/${hs.entries} entries have a title vector${hs.missing ? ` · ${hs.missing} awaiting backfill` : ""}`);
    if (hs.missing > 0) console.log("→ fill: npx tsx src/cli.ts index --optimize   (bounded batches; the weekly job also runs it)");
  }
  // Every slot on disk, built or not — `slotStatus` reads, it never derives a
  // slot into existence.
  const rows = await slotStatus();
  console.log(formatSlotTable(rows));
  const hint = slotHint(rows, idx.totalEntries);
  if (hint) console.log(hint);
  const resolution = resolveIndexSlotDetailed();
  if (resolution.warning) console.log(`⚠ ${resolution.warning}`);

  console.log("\n## Connectors");
  const { loadConnectors } = await import("./connectors.js");
  const connectors = await loadConnectors();
  const broken = connectors.filter((c) => c.error);
  if (connectors.length === 0) {
    console.log("(no connector files under connectors/)");
  } else if (broken.length === 0) {
    console.log(`${connectors.length} valid (${connectors.map((c) => c.name).join(", ")})`);
  } else {
    for (const c of broken) console.log(`✗ ${c.name}: ${c.error!.split("\n")[0]}`);
    console.log("→ fix: npx tsx src/cli.ts connectors");
  }

  console.log("\n## Dangling links");
  const chainIndex = buildChainIndex(await catalog.linked());
  const dangling = [...chainIndex.entries()].filter(([, a]) => a.dangling?.length);
  if (dangling.length === 0) {
    console.log("(none)");
  } else {
    for (const [id, a] of dangling) {
      console.log(`⚠ ${id} follows missing entr${a.dangling!.length === 1 ? "y" : "ies"}: ${a.dangling!.join(", ")}`);
    }
    console.log("→ fix: re-link with npx tsx src/cli.ts link, or remove the stale follows entry");
  }

  console.log("\n## Slug hygiene");
  const audit = analyzeGraphHygiene(entries, undefined, slugDismissalKeys(await readSlugDismissals()), await readSlugProposals());
  await writeGraphMaintenanceAudit(audit);
  if (audit.suggestions.length === 0) {
    console.log("(no suspiciously-similar slugs)");
  } else {
    for (const s of audit.suggestions) {
      console.log(
        `${s.kind}: '${s.from}' (${s.fromCount}) → '${s.to}' (${s.toCount})` +
          ` — confidence ${s.confidence.toFixed(2)}, affected ${s.affectedEntries}, last seen ${s.lastSeen ?? "n/a"}`,
      );
      console.log(`  reasons: ${s.reasons.join("; ")}`);
      console.log(
        `  preview: npx tsx src/cli.ts slugs merge --kind ${s.kind} --from ${s.from} --to ${s.to} --dry-run`,
      );
    }
  }
}
