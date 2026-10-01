import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

async function withServer<T>(cwd: string, env: Record<string, string>, fn: (base: string) => Promise<T>): Promise<T> {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), "ui", "--port", String(port), "--no-open"], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_UI_MAINTENANCE_STARTUP_DELAY_MS: "3600000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        // Any response (ok or not — an unbuilt slot answers 503) means the
        // HTTP server itself is accepting connections.
        await fetch(`${base}/api/data`);
        break;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return await fn(base);
  } finally {
    child.kill("SIGTERM");
  }
}

test("UI API reads via the catalog: /api/data, /api/graphs, /api/graphs/<slug>, /api/search agree between slots", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-server-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    runInStore(root, `const b = await import(${JSON.stringify(join(REPO, "src", "slot-build.ts"))}); console.log(JSON.stringify(await b.buildSlot({ name: "next" })));`);
    const grab = async (base: string) => ({
      data: (await (await fetch(`${base}/api/data`)).json()) as { index: { slot: string }; entries: { id: string; chain?: unknown; body: string }[] },
      graphs: await (await fetch(`${base}/api/graphs`)).json(),
      manifest: await (await fetch(`${base}/api/graphs/team-x`)).json(),
      search: await (await fetch(`${base}/api/search?q=otter+hiring+loop&k=3`)).json(),
    });
    const legacy = await withServer(root, { MEMORY_INDEX_SLOT: "legacy" }, grab);
    const next = await withServer(root, { MEMORY_INDEX_SLOT: "next" }, grab);
    assert.equal(legacy.data.index.slot, "legacy", "legacy server reports its own slot");
    assert.equal(next.data.index.slot, "next", "next-format server reports its own slot");
    const strip = (d: typeof legacy.data) => d.entries.map(({ id, chain, body }) => ({ id, chain, body }));
    assert.deepEqual(strip(next.data), strip(legacy.data), "/api/data entries agree between slot formats");
    assert.deepEqual(next.graphs, legacy.graphs, "/api/graphs agrees between slot formats");
    assert.deepEqual(next.manifest, legacy.manifest, "/api/graphs/<slug> agrees between slot formats");
    assert.equal(
      (next.search as { hits: { id: string }[] }).hits[0]!.id,
      (legacy.search as { hits: { id: string }[] }).hits[0]!.id,
      "/api/search top hit agrees between slot formats",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/api/data returns 503 with the fix-it message when the resolved slot has entries but no index", async () => {
  // No .index/ at all and no MEMORY_INDEX_SLOT override: resolution defaults
  // to the fresh format-2 slot ("main"), which has no meta.json yet — the
  // "entries on disk, no index built" case `openCatalog` refuses to answer.
  const root = mkdtempSync(join(tmpdir(), "pm-server-unbuilt-"));
  try {
    seedStore(root);
    await withServer(root, {}, async (base) => {
      const r = await fetch(`${base}/api/data`);
      assert.equal(r.status, 503, "unbuilt format-2 slot surfaces as a structured 503, not a crash");
      const body = (await r.json()) as { error: string };
      assert.match(body.error, /no index built for slot "main"/, "body carries the CLI's own fix-it message");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
