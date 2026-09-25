import type { MemoryEntry, MemoryType } from "./schema.js";

/**
 * Derived view over the `follows` links: a chain is a connected component of
 * entries describing one evolving matter (note → pending-decision → decision).
 * Everything here is computed at read time from the Markdown source of truth —
 * nothing is persisted, so it can never drift.
 */
export type ChainRelation = "supersedes" | "extends";

export interface ChainAnnotation {
  /** Valid `follows` targets of this entry (dangling ids filtered out). */
  prev: string[];
  /** Entries that declare this one in their `follows` (derived reverse links). */
  next: string[];
  /**
   * Per neighbour (prev or next): whether the LATER of the two replaces the
   * earlier one's state (`supersedes`) or only adds to it (`extends`).
   * Derived from types — see `relationOf`.
   */
  relations: Record<string, ChainRelation>;
  /** True when some follower supersedes this entry: its state is stale. */
  superseded: boolean;
  /**
   * The entry that now holds this matter's state: the newest reachable over
   * `supersedes` edges only; the entry itself when nothing supersedes it.
   */
  current: { id: string; type: MemoryType; date: string };
  /** The most current member of the whole chain, by max(date, updated). */
  latest: { id: string; type: MemoryType; date: string };
  /**
   * For open types only: the entry that settles this matter — the nearest
   * transitive descendant of type `decision`, else the latest descendant.
   */
  resolvedBy?: string;
  /** Only on `pending-decision` / `todo`: resolved iff any descendant exists. */
  status?: "open" | "resolved";
  /** `follows` ids that no longer exist (e.g. after `remove`). */
  dangling?: string[];
}

const OPEN_TYPES: ReadonlySet<MemoryType> = new Set(["pending-decision", "todo"]);

/** Types whose follower settles an open item (`pending-decision` / `todo`). */
const CLOSING_TYPES: ReadonlySet<MemoryType> = new Set(["decision", "todo", "note"]);

/**
 * A follower SUPERSEDES its predecessor when it is the same type (a newer
 * decision replaces a decision, a newer note a note) or when it closes an
 * open type (a decision/todo/note after a pending-decision or todo). Anything
 * else — a meeting after a decision, a pending item raised from a note —
 * EXTENDS: the earlier entry is still the state, developments were added.
 */
export function relationOf(predecessor: MemoryType, follower: MemoryType): ChainRelation {
  if (follower === predecessor) return "supersedes";
  if (OPEN_TYPES.has(predecessor) && CLOSING_TYPES.has(follower)) return "supersedes";
  return "extends";
}

/** The date an entry last "spoke": `updated` when newer than `date`. */
function refDate(e: MemoryEntry): string {
  return e.updated && e.updated > e.date ? e.updated : e.date;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const xs = map.get(key);
  if (xs) xs.push(value);
  else map.set(key, [value]);
}

/** Ids of all transitive descendants, in BFS order; cycle-safe. */
function descendants(id: string, next: Map<string, string[]>): string[] {
  const seen = new Set<string>([id]);
  const out: string[] = [];
  const queue = [...(next.get(id) ?? [])];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    queue.push(...(next.get(cur) ?? []));
  }
  return out;
}

/**
 * Display status for an entry: chained open-types report their chain status;
 * an UNLINKED pending-decision/todo is simply open. Non-open types have none.
 */
export function entryStatus(
  e: MemoryEntry,
  index: Map<string, ChainAnnotation>,
): { status: "open" | "resolved"; resolvedBy?: string } | undefined {
  if (!OPEN_TYPES.has(e.type)) return undefined;
  const annotation = index.get(e.id);
  if (!annotation?.status) return { status: "open" };
  return annotation.status === "resolved"
    ? { status: "resolved", ...(annotation.resolvedBy ? { resolvedBy: annotation.resolvedBy } : {}) }
    : { status: "open" };
}

/**
 * Write-time guard for new `follows` links: every target must exist, be no
 * newer than the follower, not be the follower itself, and not already follow
 * the follower (directly or transitively) — so the CLI can never create a
 * cycle. `source` may be an entry that does not exist yet (a fresh capture).
 */
export function validateFollowsTargets(
  entries: MemoryEntry[],
  source: { id: string; date: string },
  targets: string[],
): void {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  for (const target of targets) {
    if (target === source.id) {
      throw new Error(`--follows: '${source.id}' cannot follow itself`);
    }
    const t = byId.get(target);
    if (!t) throw new Error(`--follows: no entry with id '${target}'`);
    if (t.date > source.date) {
      throw new Error(
        `--follows: target '${target}' (${t.date}) must not be newer than '${source.id}' (${source.date})`,
      );
    }
    // Walk the target's ancestry (its own follows, transitively): reaching the
    // source means the new link would close a loop.
    const seen = new Set<string>();
    const queue = [...(t.follows ?? [])];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === source.id) {
        throw new Error(`--follows: linking '${source.id}' → '${target}' would create a cycle`);
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      queue.push(...(byId.get(cur)?.follows ?? []));
    }
  }
}

/**
 * Build the chain index: only entries participating in a chain (linking,
 * linked-to, or carrying dangling links) get an annotation; everything else is
 * absent. O(component) per entry — trivial at this corpus size.
 */
export function buildChainIndex(entries: MemoryEntry[]): Map<string, ChainAnnotation> {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const prev = new Map<string, string[]>();
  const next = new Map<string, string[]>();
  const dangling = new Map<string, string[]>();

  for (const e of entries) {
    for (const target of e.follows ?? []) {
      if (target === e.id) continue; // defensive: self-links are meaningless
      if (byId.has(target)) {
        push(prev, e.id, target);
        push(next, target, e.id);
      } else {
        push(dangling, e.id, target);
      }
    }
  }

  const members = new Set<string>([...prev.keys(), ...next.keys(), ...dangling.keys()]);
  const index = new Map<string, ChainAnnotation>();
  if (members.size === 0) return index;

  const newer = (a: string, b: string): string => {
    const cmp = refDate(byId.get(a)!).localeCompare(refDate(byId.get(b)!));
    if (cmp !== 0) return cmp > 0 ? a : b;
    // Same-day: topology decides — a link points at the newer development.
    if (descendants(a, next).includes(b)) return b;
    if (descendants(b, next).includes(a)) return a;
    return a.localeCompare(b) >= 0 ? a : b;
  };

  // Latest member per connected component (undirected walk over valid links).
  const latestOf = new Map<string, string>();
  const assigned = new Set<string>();
  for (const start of members) {
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const queue = [start];
    while (queue.length) {
      const cur = queue.pop()!;
      if (assigned.has(cur)) continue;
      assigned.add(cur);
      component.push(cur);
      queue.push(...(prev.get(cur) ?? []), ...(next.get(cur) ?? []));
    }
    const latest = component.reduce(newer);
    for (const id of component) latestOf.set(id, latest);
  }

  // Reverse links restricted to superseding followers: `current` walks these.
  const supersedingNext = new Map<string, string[]>();
  for (const [target, followers] of next) {
    const t = byId.get(target)!;
    for (const f of followers) {
      if (relationOf(t.type, byId.get(f)!.type) === "supersedes") push(supersedingNext, target, f);
    }
  }

  for (const id of members) {
    const e = byId.get(id)!;
    const latestEntry = byId.get(latestOf.get(id)!)!;
    const relations: Record<string, ChainRelation> = {};
    for (const p of prev.get(id) ?? []) relations[p] = relationOf(byId.get(p)!.type, e.type);
    for (const n of next.get(id) ?? []) relations[n] = relationOf(e.type, byId.get(n)!.type);
    const replacements = descendants(id, supersedingNext);
    const currentEntry = byId.get(replacements.length ? replacements.reduce(newer) : id)!;
    const annotation: ChainAnnotation = {
      prev: prev.get(id) ?? [],
      next: next.get(id) ?? [],
      relations,
      superseded: replacements.length > 0,
      current: { id: currentEntry.id, type: currentEntry.type, date: currentEntry.date },
      latest: { id: latestEntry.id, type: latestEntry.type, date: latestEntry.date },
    };
    const danglingIds = dangling.get(id);
    if (danglingIds) annotation.dangling = danglingIds;

    if (OPEN_TYPES.has(e.type)) {
      const desc = descendants(id, next);
      if (desc.length === 0) {
        annotation.status = "open";
      } else {
        annotation.status = "resolved";
        annotation.resolvedBy =
          desc.find((d) => byId.get(d)!.type === "decision") ?? desc.reduce(newer);
      }
    }

    index.set(id, annotation);
  }

  return index;
}
