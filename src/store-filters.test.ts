import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { packSlugs } from "./schema.js";
import { applyFilters, whereClause, SLUG_RE, type Filterable, type SearchFilters } from "./ranking.js";

/**
 * Parity between the SQL prefilter (`whereClause`, applied inside LanceDB so
 * vector truncation happens within the candidate space) and the JS authority
 * (`applyFilters`). Contract: SQL ⊇ JS always; SQL == JS whenever every filter
 * value passes validation (otherwise the SQL side just omits that clause).
 */

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(7);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
const some = <T>(xs: T[], max: number): T[] => {
  const n = Math.floor(rand() * (max + 1));
  const out = new Set<T>();
  while (out.size < n) out.add(pick(xs));
  return [...out];
};

const SLUGS = ["ana", "an", "boris", "chen", "dana-levi", "eli", "x1", "y2", "z3", "long-slug-name", "a", "b", "c", "d", "e"];
const TYPES = ["event", "decision", "todo", "pending-decision", "1on1", "hiring", "incident", "note", "summary"];
const GRAPHS = ["default", "team-x", "g"];

function entry(i: number): Filterable {
  const y = 2023 + Math.floor(rand() * 4);
  const m = 1 + Math.floor(rand() * 12);
  const d = 1 + Math.floor(rand() * 28);
  return {
    id: `e${i}`,
    date: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    type: pick(TYPES),
    people: some(SLUGS, 3),
    teams: some(SLUGS, 2),
    tags: some(SLUGS, 3),
    graphs: ["default", ...some(GRAPHS.slice(1), 2)],
  };
}

function filters(): SearchFilters {
  const f: SearchFilters = {};
  const maybe = (p: number) => rand() < p;
  if (maybe(0.4)) f.person = pick([...SLUGS, "Jane Doe", "x' OR 1=1"]);
  if (maybe(0.3)) f.team = pick(SLUGS);
  if (maybe(0.4)) f.tag = pick(SLUGS);
  if (maybe(0.3)) f.type = pick([...TYPES, "Decision"]);
  if (maybe(0.4)) f.since = pick(["2023-06-01", "2025-01-01", "2026-12-31", "yesterday"]);
  if (maybe(0.4)) f.until = pick(["2024-06-01", "2026-01-01", "2023-01-01"]);
  if (maybe(0.3)) f.graph = pick(GRAPHS);
  return f;
}

function allValid(f: SearchFilters): boolean {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  return [f.person, f.team, f.tag, f.type, f.graph].every((v) => v === undefined || SLUG_RE.test(v)) &&
    [f.since, f.until].every((v) => v === undefined || DATE.test(v));
}

test("whereClause ⊇ applyFilters on random entries, and == when every value validates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-filters-"));
  try {
    const entries = Array.from({ length: 300 }, (_, i) => entry(i));
    const db = await lancedb.connect(dir);
    const table = await db.createTable(
      "t",
      entries.map((e) => ({
        id: e.id,
        date: e.date,
        type: e.type,
        people: packSlugs(e.people),
        teams: packSlugs(e.teams),
        tags: packSlugs(e.tags),
        graphs: packSlugs(e.graphs),
      })),
    );

    let exact = 0;
    for (let i = 0; i < 200; i++) {
      const f = filters();
      const js = new Set(applyFilters(entries, f).map((e) => e.id));
      const where = whereClause(f);
      let q = table.query();
      if (where) q = q.where(where);
      const sql = new Set(((await q.select(["id"]).toArray()) as { id: string }[]).map((r) => r.id));
      for (const id of js) assert.ok(sql.has(id), `SQL dropped ${id} for ${JSON.stringify(f)}`);
      if (allValid(f)) {
        exact++;
        assert.equal(sql.size, js.size, `SQL over-included for ${JSON.stringify(f)}: ${sql.size} vs ${js.size}`);
      }
    }
    assert.ok(exact > 50, `only ${exact} fully-valid filter draws`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pipe delimiters: person 'an' must not match '|ana|', and no-people entries match nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-filters-"));
  try {
    const db = await lancedb.connect(dir);
    const table = await db.createTable("t", [
      { id: "ana", people: packSlugs(["ana"]) },
      { id: "an", people: packSlugs(["an"]) },
      { id: "none", people: packSlugs([]) },
    ]);
    const rows = (await table.query().where(whereClause({ person: "an" })!).select(["id"]).toArray()) as { id: string }[];
    assert.deepEqual(rows.map((r) => r.id), ["an"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
