import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { LanceCatalog } from "./catalog-lance.js";
import { readManifest, syncCatalogFromDisk } from "./catalog-sync.js";
import { md } from "./test-store.js";

function store(root: string) {
  return { graph: "default", dir: join(root, "memory"), entriesDir: join(root, "memory", "entries"), summariesDir: join(root, "memory", "summaries"), manifestPath: join(root, "memory", "GRAPH.md") };
}

function write(root: string, id: string, date: string, title: string): void {
  const [y, m] = date.split("-");
  const dir = join(root, "memory", "entries", y!, m!);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.md`), md({ id, date, type: "note", title, people: [], teams: [], tags: [] }, `${title} body`));
}

test("refresh: builds a missing catalog, then stays quiet until a directory changes; strict mode always re-syncs", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-fresh-")));
  const slot = join(root, ".index", "slots", "main");
  try {
    write(root, "2026-01-01-alpha", "2026-01-01", "Alpha");
    const stores = [store(root)];
    const first = await LanceCatalog.open({ slot: "main", dir: slot, root, stores, mode: "fts" });
    assert.equal(await first.count(), 1, "missing tables → built from disk on open");
    assert.equal((await readManifest(slot))!.generation, 1);

    const quiet = await LanceCatalog.open({ slot: "main", dir: slot, root, stores, mode: "fts", autoRefresh: false });
    assert.deepEqual(await quiet.refresh(), { refreshed: false }, "no dir changed → no sync");

    // A new month directory appears (parent entries/2026 mtime changes) → refreshed.
    write(root, "2026-02-01-beta", "2026-02-01", "Beta");
    assert.deepEqual(await quiet.refresh(), { refreshed: true });
    assert.equal(await quiet.count(), 2);
    assert.equal((await readManifest(slot))!.generation, 2);

    // A file deleted from an existing month dir → that dir's mtime changes → refreshed.
    rmSync(join(root, "memory", "entries", "2026", "01", "2026-01-01-alpha.md"));
    assert.deepEqual(await quiet.refresh(), { refreshed: true });
    assert.equal(await quiet.count(), 1);

    // In-place edit (same path): dir mtime unchanged → NOT detected without strict.
    const beta = join(root, "memory", "entries", "2026", "02", "2026-02-01-beta.md");
    const dirStat = join(root, "memory", "entries", "2026", "02");
    const dirMtimeMs = statSync(dirStat).mtimeMs;
    const before = readFileSync(beta, "utf8");
    writeFileSync(beta, before.replace("Beta body", "Beta body edited"));
    // Restore the directory's mtime with full precision: a raw seconds NUMBER,
    // never a `Date` — `Date` truncates to whole milliseconds and utimesSync's
    // internal unix-timestamp conversion loses still more precision from there
    // at this epoch's magnitude (measured ~0.1-0.8ms drift via `new Date(ms)`;
    // a raw-number round-trip of `mtimeMs / 1000` is accurate to ~0.001ms).
    utimesSync(dirStat, new Date(0), dirMtimeMs / 1000);
    assert.deepEqual(await quiet.refresh(), { refreshed: false }, "documented gap: in-place edits need strict or a writer sync");
    process.env.MEMORY_SYNC = "strict";
    try {
      assert.deepEqual(await quiet.refresh(), { refreshed: true }, "strict forces the scan");
    } finally {
      delete process.env.MEMORY_SYNC;
    }
    const edited = await quiet.hydrate(await quiet.byIds(["2026-02-01-beta"]));
    assert.match(edited[0]!.body, /edited/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncCatalogFromDisk never touches vector tables", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-fresh-vec-")));
  const slot = join(root, ".index", "slots", "main");
  try {
    write(root, "2026-01-01-alpha", "2026-01-01", "Alpha");
    const db = await lancedb.connect(slot);
    await db.createTable("memory", [{ id: "x", hash: "h", vector: [0.1, 0.2] }]);
    await syncCatalogFromDisk(db, slot, { root, stores: [store(root)] });
    assert.deepEqual((await db.tableNames()).sort(), ["entries", "files", "memory"]);
    assert.equal(await (await db.openTable("memory")).countRows(), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
