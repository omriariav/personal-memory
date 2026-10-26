import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

/**
 * The sources screens are backed by two endpoints only — no lookup ever runs
 * over HTTP (see docs/superpowers/specs/sources-ui-design.md). These tests
 * drive the real server in a scratch store, the same way server-catalog does.
 */

const TEMPLATE = `---
name: people-directory
kind: person
enabled: false
lookup:
  command: "your-directory-lookup {query}"
---

# Resolving people

Consult before minting a new slug.
`;

const OVERRIDE = TEMPLATE.replace("enabled: false", "enabled: true").replace(
  "your-directory-lookup {query}",
  "my-dir --name {query}",
);

async function withServer<T>(cwd: string, fn: (base: string) => Promise<T>): Promise<T> {
  const port = 43000 + Math.floor(Math.random() * 2000);
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(REPO, "node_modules", "tsx", "dist", "loader.mjs"),
      join(REPO, "src", "cli.ts"),
      "ui",
      "--port",
      String(port),
      "--no-open",
    ],
    {
      cwd,
      env: {
        ...process.env,
        MEMORY_EMBEDDINGS: "fake",
        MEMORY_UI_MAINTENANCE_STARTUP_DELAY_MS: "3600000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try {
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

type SourceRow = {
  name: string;
  kind: string;
  origin: string;
  path: string;
  enabled: boolean;
  lookup?: { command: string };
  raw: string;
  error?: string;
};

const getSources = async (base: string): Promise<SourceRow[]> =>
  ((await (await fetch(`${base}/api/sources`)).json()) as { sources: SourceRow[] }).sources;

const put = (base: string, name: string, body: string) =>
  fetch(`${base}/api/sources/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
    body,
  });

function scratchStore(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-server-sources-"));
  seedStore(root);
  runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`);
  mkdirSync(join(root, "sources"), { recursive: true });
  writeFileSync(join(root, "sources", "people-directory.md"), TEMPLATE, "utf8");
  return root;
}

test("GET /api/sources lists templates with their lookup contract, running nothing", { timeout: 300_000 }, async () => {
  const root = scratchStore();
  try {
    await withServer(root, async (base) => {
      const sources = await getSources(base);
      assert.equal(sources.length, 1);
      const s = sources[0]!;
      assert.equal(s.name, "people-directory");
      assert.equal(s.kind, "person");
      assert.equal(s.origin, "template");
      assert.equal(s.enabled, false);
      assert.equal(s.lookup?.command, "your-directory-lookup {query}");
      assert.equal(s.path, "sources/people-directory.md");
      assert.ok(s.raw.includes("# Resolving people"));
      assert.equal(s.error, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/sources reports a file that fails validation instead of hiding it", { timeout: 300_000 }, async () => {
  const root = scratchStore();
  writeFileSync(join(root, "sources", "broken.md"), TEMPLATE.replace("name: people-directory", "name: broken").replace("kind: person", "kind: org"), "utf8");
  try {
    await withServer(root, async (base) => {
      const broken = (await getSources(base)).find((s) => s.name === "broken");
      assert.match(broken?.error ?? "", /invalid source frontmatter/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT /api/sources/<name> saves into the private override layer", { timeout: 300_000 }, async () => {
  const root = scratchStore();
  try {
    await withServer(root, async (base) => {
      const res = await put(base, "people-directory", OVERRIDE);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { path: string }).path, "memory/sources/people-directory.md");

      // the template is untouched; the override now wins
      assert.equal(readFileSync(join(root, "sources", "people-directory.md"), "utf8"), TEMPLATE);
      const s = (await getSources(base)).find((x) => x.name === "people-directory");
      assert.equal(s?.origin, "override");
      assert.equal(s?.enabled, true);
      assert.equal(s?.lookup?.command, "my-dir --name {query}");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT /api/sources/<name> rejects invalid content and writes nothing", { timeout: 300_000 }, async () => {
  const root = scratchStore();
  try {
    await withServer(root, async (base) => {
      const res = await put(base, "people-directory", OVERRIDE.replace("kind: person", "kind: org"));
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, /invalid source frontmatter/);
      assert.equal(existsSync(join(root, "memory", "sources", "people-directory.md")), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PUT /api/sources/<name> rejects an empty body and a non-slug name", { timeout: 300_000 }, async () => {
  const root = scratchStore();
  try {
    await withServer(root, async (base) => {
      assert.equal((await put(base, "people-directory", "   ")).status, 400);
      assert.equal((await put(base, "..%2Fescaped", OVERRIDE)).status, 404);
      assert.equal((await put(base, "Not-A-Slug", OVERRIDE)).status, 404);
      assert.equal(existsSync(join(root, "memory", "sources")), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const setEnabled = (base: string, name: string, enabled: boolean) =>
  fetch(`${base}/api/sources/${name}/enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });

test("POST /api/sources/<name>/enabled toggles the flag without touching the rest", { timeout: 300_000 }, async () => {
  const root = scratchStore();
  try {
    await withServer(root, async (base) => {
      // enabling a template-backed source creates the override
      const on = await setEnabled(base, "people-directory", true);
      assert.equal(on.status, 200);
      // the response carries the NEW file text: the detail screen's editor must
      // re-render from it, or a later save there would write the stale flag back
      const onBody = (await on.json()) as { enabled: boolean; raw: string };
      assert.equal(onBody.enabled, true);
      assert.match(onBody.raw, /^enabled: true$/m);
      assert.ok(onBody.raw.includes("your-directory-lookup {query}"));
      const s = (await getSources(base)).find((x) => x.name === "people-directory");
      assert.equal(s?.enabled, true);
      assert.equal(s?.origin, "override");
      // the command and the guidance body survive the toggle
      assert.equal(s?.lookup?.command, "your-directory-lookup {query}");
      assert.ok(s?.raw.includes("# Resolving people"));
      // the tracked template is untouched
      assert.equal(readFileSync(join(root, "sources", "people-directory.md"), "utf8"), TEMPLATE);

      const off = await setEnabled(base, "people-directory", false);
      assert.equal(off.status, 200);
      assert.equal((await getSources(base)).find((x) => x.name === "people-directory")?.enabled, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/sources/<name>/enabled rejects a bad name, body, and unknown source", { timeout: 300_000 }, async () => {
  const root = scratchStore();
  try {
    await withServer(root, async (base) => {
      assert.equal((await setEnabled(base, "Not-A-Slug", true)).status, 404);
      assert.equal((await setEnabled(base, "no-such-source", true)).status, 400);
      const bad = await fetch(`${base}/api/sources/people-directory/enabled`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: "yes please" }),
      });
      assert.equal(bad.status, 400);
      // nothing was written by any of the rejected calls
      assert.equal(existsSync(join(root, "memory", "sources")), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
