import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { hashEntry } from "./ingest.js";
import { metaOf } from "./catalog.js";
import { LanceCatalog } from "./catalog-lance.js";
import type { Store } from "./graphs.js";
import type { MemoryEntry } from "./schema.js";
import {
  dropCatalogTables,
  ensureCatalogIndices,
  entryRowFor,
  manifestFor,
  metaFromRow,
  openCatalogTables,
  readManifest,
  scanDirMtimes,
  syncCatalogTables,
  writeManifest,
} from "./catalog-sync.js";

/**
 * Unit coverage for the catalog's write side — the incremental rules
 * (`syncCatalogTables`), the row ⇄ meta round trip, the manifest, and the
 * build-from-disk path `LanceCatalog.refresh()` takes. The shadow test only
 * ever builds once; everything here is the second build onwards.
 */

function storeDirOf(root: string, graph: string): string {
  return graph === "default" ? join(root, "memory") : join(root, "memory-graphs", graph);
}

function storeOf(root: string, graph: string): Store {
  const dir = storeDirOf(root, graph);
  return { graph, dir, entriesDir: join(dir, "entries"), summariesDir: join(dir, "summaries"), manifestPath: join(dir, "GRAPH.md") };
}

interface EntrySpec {
  id: string;
  date?: string;
  type?: MemoryEntry["type"];
  title?: string;
  body?: string;
  tags?: string[];
  follows?: string[];
  updated?: string;
  graphs?: string[];
}

/** Materialize the Markdown of every membership and return the logical entry. */
function makeEntry(root: string, p: EntrySpec): MemoryEntry {
  const date = p.date ?? "2026-01-01";
  const type = p.type ?? "note";
  const title = p.title ?? `title of ${p.id}`;
  const body = p.body ?? `body of ${p.id}`;
  const tags = p.tags ?? [];
  const graphs = p.graphs ?? ["default"];
  const [y, m] = date.split("-");
  const fm = [
    "---",
    `id: ${p.id}`,
    `date: ${date}`,
    `type: ${type}`,
    `title: ${JSON.stringify(title)}`,
    ...(tags.length ? ["tags:", ...tags.map((t) => `  - ${t}`)] : []),
    ...(p.follows?.length ? ["follows:", ...p.follows.map((f) => `  - ${f}`)] : []),
    ...(p.updated ? [`updated: ${p.updated}`] : []),
    "---",
  ].join("\n");
  const paths: Record<string, string> = {};
  for (const g of graphs) {
    const dir = join(storeDirOf(root, g), "entries", y!, m!);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${p.id}.md`);
    writeFileSync(path, `${fm}\n\n${body}\n`, "utf8");
    paths[g] = path;
  }
  return {
    id: p.id,
    date,
    type,
    title,
    people: [],
    teams: [],
    tags,
    ...(p.follows?.length ? { follows: p.follows } : {}),
    ...(p.updated ? { updated: p.updated } : {}),
    body,
    path: paths[graphs[0]!]!,
    paths,
    graphs,
  };
}

async function entryIds(db: lancedb.Connection): Promise<string[]> {
  const { entries } = await openCatalogTables(db);
  if (!entries) return [];
  const rows = (await entries.query().select(["id"]).toArray()) as { id: string }[];
  return rows.map((r) => r.id).sort();
}

async function fileRelpaths(db: lancedb.Connection): Promise<string[]> {
  const { files } = await openCatalogTables(db);
  if (!files) return [];
  const rows = (await files.query().select(["relpath"]).toArray()) as { relpath: string }[];
  return rows.map((r) => r.relpath).sort();
}

function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("syncCatalogTables: first build, idempotent re-sync, content change, membership change, deletion", async () => {
  const root = tempRoot("pm-catsync-");
  try {
    const db = await lancedb.connect(join(root, ".index", "slots", "next"));
    const a = makeEntry(root, { id: "2026-01-01-a" });
    const b = makeEntry(root, { id: "2026-02-01-b", date: "2026-02-01", type: "decision" });

    assert.deepEqual(await syncCatalogTables(db, [a, b], { root }), { added: 2, removed: 0, unchanged: 0 }, "first build adds every entry");
    assert.deepEqual(await entryIds(db), ["2026-01-01-a", "2026-02-01-b"]);
    assert.deepEqual(await fileRelpaths(db), [relative(root, a.path), relative(root, b.path)].sort());

    assert.deepEqual(await syncCatalogTables(db, [a, b], { root }), { added: 0, removed: 0, unchanged: 2 }, "an unchanged corpus rewrites nothing");

    // content change: same id, new hash → exactly one row replaced
    const a2 = makeEntry(root, { id: "2026-01-01-a", body: "rewritten body" });
    assert.notEqual(hashEntry(a2), hashEntry(a), "the fixture really changed");
    assert.deepEqual(await syncCatalogTables(db, [a2, b], { root }), { added: 1, removed: 0, unchanged: 1 });
    assert.deepEqual(await entryIds(db), ["2026-01-01-a", "2026-02-01-b"], "a replaced entry is not duplicated");
    const { entries: table } = await openCatalogTables(db);
    const rows = (await table!.query().select(["id", "hash"]).where("id = '2026-01-01-a'").toArray()) as { id: string; hash: string }[];
    assert.equal(rows.length, 1, "one row per entry after a replace");
    assert.equal(rows[0]!.hash, hashEntry(a2), "the row carries the new hash");

    // membership change only: the hash is unchanged, the row must still be replaced
    const b2 = makeEntry(root, { id: "2026-02-01-b", date: "2026-02-01", type: "decision", graphs: ["default", "team-x"] });
    assert.equal(hashEntry(b2), hashEntry(b), "copying between graphs never changes the content hash");
    assert.deepEqual(await syncCatalogTables(db, [a2, b2], { root }), { added: 1, removed: 0, unchanged: 1 }, "a membership change replaces the row");
    assert.deepEqual(await fileRelpaths(db), [relative(root, a2.path), ...Object.values(b2.paths).map((p) => relative(root, p))].sort(), "one file row per materialization");

    assert.deepEqual(await syncCatalogTables(db, [a2], { root }), { added: 0, removed: 1, unchanged: 1 }, "a dropped entry is removed");
    assert.deepEqual(await entryIds(db), ["2026-01-01-a"]);
    assert.deepEqual(await fileRelpaths(db), [relative(root, a2.path)], "its file rows go with it");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("entryRowFor/metaFromRow round-trip to the same meta LegacyCatalog would emit", () => {
  const root = tempRoot("pm-catrow-");
  try {
    for (const spec of [
      { id: "2026-01-01-plain" },
      { id: "2026-03-01-rich", date: "2026-03-01", type: "decision" as const, tags: ["budget", "k8s"], follows: ["2026-01-01-plain"], updated: "2026-04-01", graphs: ["default", "team-x"] },
    ]) {
      const e = makeEntry(root, spec);
      const { lex: _lex, ...row } = entryRowFor(e, root);
      assert.deepEqual(metaFromRow(row, root), metaOf(e), spec.id);
    }
    const e = makeEntry(root, { id: "2026-01-01-plain" });
    const row = entryRowFor(e, root);
    assert.equal(row.updated, "", "an unset updated is stored as the empty string");
    assert.equal(row.home_path, relative(root, e.path), "paths are stored relative to the root");
    assert.ok(row.len > 0 && row.lex.split(" ").length === row.len, "len is the token count of lex");
    assert.ok(row.chunks >= 1, "every entry has at least one chunk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifest: round-trip, generation increments, N/avgdl read from the entries table", async () => {
  const root = tempRoot("pm-catman-");
  try {
    const dir = join(root, ".index", "slots", "next");
    const db = await lancedb.connect(dir);
    assert.equal(await readManifest(dir), null, "no manifest before the first write");

    const entries = [makeEntry(root, { id: "2026-01-01-a" }), makeEntry(root, { id: "2026-02-01-b", date: "2026-02-01" })];
    await syncCatalogTables(db, entries, { root });
    const dirs = await scanDirMtimes([storeOf(root, "default")], root);
    assert.ok(Object.keys(dirs).includes(join("memory", "entries")), `entries dir is tracked: ${Object.keys(dirs).join(", ")}`);
    assert.ok(Object.keys(dirs).includes(join("memory", "entries", "2026", "01")), "per-month dirs are tracked");

    const first = await manifestFor(db, dirs, null);
    assert.equal(first.generation, 1);
    assert.equal(first.N, 2);
    const expectedAvgdl = entries.reduce((s, e) => s + entryRowFor(e, root).len, 0) / 2;
    assert.equal(first.avgdl, expectedAvgdl, "avgdl is the mean token count");
    await writeManifest(dir, first);
    assert.deepEqual(await readManifest(dir), first, "the manifest round-trips through zod");

    const second = await manifestFor(db, dirs, await readManifest(dir));
    assert.equal(second.generation, 2, "generation advances from the previous manifest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dropCatalogTables removes both tables and is a no-op on an empty connection", async () => {
  const root = tempRoot("pm-catdrop-");
  try {
    const db = await lancedb.connect(join(root, ".index", "slots", "next"));
    await dropCatalogTables(db); // nothing to drop
    await syncCatalogTables(db, [makeEntry(root, { id: "2026-01-01-a" })], { root });
    assert.deepEqual((await db.tableNames()).sort(), ["entries", "files"]);
    await dropCatalogTables(db);
    assert.deepEqual(await db.tableNames(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LanceCatalog.open with autoRefresh builds the catalog from the Markdown on disk", async () => {
  const root = tempRoot("pm-catrefresh-");
  try {
    const dir = join(root, ".index", "slots", "next");
    const stores = [storeOf(root, "default")];
    makeEntry(root, { id: "2026-01-01-a", tags: ["budget"] });
    makeEntry(root, { id: "2026-02-01-b", date: "2026-02-01", type: "decision", follows: ["2026-01-01-a"] });

    const catalog = await LanceCatalog.open({ slot: "next", dir, root, stores, mode: "postings" });
    assert.equal(catalog.kind, "lance");
    assert.equal(catalog.format, 2);
    assert.equal(await catalog.count(), 2, "both entries were ingested from disk");
    assert.deepEqual((await catalog.filter({ tag: "budget" })).map((m) => m.id), ["2026-01-01-a"]);
    assert.deepEqual((await catalog.referrers("2026-01-01-a")).map((m) => m.id), ["2026-02-01-b"]);
    assert.deepEqual((await catalog.linked()).map((m) => m.id).sort(), ["2026-01-01-a", "2026-02-01-b"]);
    assert.ok((await catalog.lexical("budget", new Set(["2026-01-01-a"]), 10)).length > 0, "the lexical leg scores the rebuilt index");

    const manifest = await readManifest(dir);
    assert.equal(manifest?.N, 2, "refresh wrote a manifest");
    assert.deepEqual(await catalog.refresh(), { refreshed: false }, "an existing table is not rebuilt");

    // the indices survive a reopen and the FTS leg answers from them
    await ensureCatalogIndices(await lancedb.connect(dir));
    const reopened = await LanceCatalog.open({ slot: "next", dir, root, stores, mode: "fts", autoRefresh: false });
    assert.deepEqual((await reopened.lexical("budget", new Set(["2026-01-01-a"]), 10)).map((h) => h.id), ["2026-01-01-a"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
