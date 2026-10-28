import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, seedStore } from "./test-store.js";

/**
 * The review queue over HTTP. The assertions that matter most are the
 * negative ones: a refused approve must leave nothing behind in the shared
 * store, and a graph whose slug merely starts with "queue" must not be
 * mistaken for the queue route.
 */

const ID = "2026-01-03-otter-hiring";

function cli(cwd: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args],
    { cwd, env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

async function withServer<T>(cwd: string, fn: (base: string) => Promise<T>): Promise<T> {
  // 45000+ — 41000 is server-catalog's band, 43000 is server-sources'.
  const port = 45000 + Math.floor(Math.random() * 2000);
  const child = spawn(
    process.execPath,
    ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), "ui", "--port", String(port), "--no-open"],
    {
      cwd,
      env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_UI_MAINTENANCE_STARTUP_DELAY_MS: "3600000" },
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
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return await fn(base);
  } finally {
    child.kill("SIGTERM");
  }
}

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function store(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-srv-queue-")));
    try {
      seedStore(root);
      cli(root, ["index"]);
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const sharedFile = (root: string) =>
  join(root, "memory-graphs", "team-x", "entries", "2026", "01", `${ID}.md`);

test("GET /api/queue reports every named graph, never the default one", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "fits"]);
  await withServer(root, async (base) => {
    const data = (await (await fetch(`${base}/api/queue`)).json()) as {
      totalPending: number;
      graphs: { graph: string; pending: number; members: number }[];
      rows: { id: string; reason: string; path: string }[];
    };
    assert.equal(data.totalPending, 1);
    assert.deepEqual(data.graphs.map((g) => g.graph), ["team-x"]);
    assert.equal(data.graphs[0]!.pending, 1);
    assert.equal(data.rows[0]!.id, ID);
    assert.match(data.rows[0]!.reason, /fits/);
    assert.doesNotMatch(data.rows[0]!.path, /^\//, "paths are repo-relative, not absolute");
  });
}));

test("GET /api/queue/default is refused rather than dumping every entry", { timeout: 300_000 }, store(async (root) => {
  await withServer(root, async (base) => {
    const res = await fetch(`${base}/api/queue/default`);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /every entry's home/);
  });
}));

test("an unknown graph is a 404, and a non-slug never reaches the registry", { timeout: 300_000 }, store(async (root) => {
  await withServer(root, async (base) => {
    assert.equal((await fetch(`${base}/api/queue/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/queue/Bad_Slug`)).status, 404);
  });
}));

test("a graph whose slug starts with 'queue' is not swallowed by the route", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["graphs", "create", "queue-archive"]);
  cli(root, ["queue", "add", ID, "--to", "queue-archive", "--reason", "archival"]);
  await withServer(root, async (base) => {
    const data = (await (await fetch(`${base}/api/queue/queue-archive`)).json()) as {
      graphs: { graph: string }[];
      rows: { id: string }[];
    };
    assert.deepEqual(data.graphs.map((g) => g.graph), ["queue-archive"]);
    assert.equal(data.rows[0]!.id, ID);
  });
}));

test("approve without confirm is refused and publishes nothing", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "fits"]);
  await withServer(root, async (base) => {
    const res = await post(base, "/api/queue/team-x/approve", { id: ID });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /confirm: true/);
    assert.equal(existsSync(sharedFile(root)), false, "the refusal left nothing behind");
  });
}));

test("a cross-origin approve is refused by the loopback guard", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "fits"]);
  await withServer(root, async (base) => {
    const res = await post(base, "/api/queue/team-x/approve", { id: ID, confirm: true }, { Origin: "https://evil.example" });
    assert.equal(res.status, 403);
    assert.equal(existsSync(sharedFile(root)), false);
  });
}));

test("approve publishes the entry's own wording, and the row goes away", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "fits"]);
  await withServer(root, async (base) => {
    const res = await post(base, "/api/queue/team-x/approve", { id: ID, confirm: true });
    assert.equal(res.status, 200);
    assert.match(readFileSync(sharedFile(root), "utf8"), /interviews and offers/);

    const after = (await (await fetch(`${base}/api/queue`)).json()) as { totalPending: number };
    assert.equal(after.totalPending, 0);
  });
}));

test("approving twice is a 404, never a second copy", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "fits"]);
  await withServer(root, async (base) => {
    assert.equal((await post(base, "/api/queue/team-x/approve", { id: ID, confirm: true })).status, 200);
    const second = await post(base, "/api/queue/team-x/approve", { id: ID, confirm: true });
    assert.equal(second.status, 404, "double-clicks are the normal case");
  });
}));

test("asking for a summary that was never drafted is a 404, not a silent raw copy", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "fits"]);
  await withServer(root, async (base) => {
    const res = await post(base, "/api/queue/team-x/approve", { id: ID, variant: "summary", confirm: true });
    assert.equal(res.status, 404);
    assert.equal(existsSync(sharedFile(root)), false);
  });
}));

test("approving a blocked candidate is a 409 naming its blockers", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", "2026-01-05-budget-decided", "--to", "team-x", "--reason", "the decision matters"]);
  await withServer(root, async (base) => {
    const res = await post(base, "/api/queue/team-x/approve", { id: "2026-01-05-budget-decided", confirm: true });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { blockedBy: string[] };
    assert.deepEqual(body.blockedBy, ["2026-01-04-budget-pending"]);
  });
}));

test("enqueue adds a blocker, and approving it unblocks the original", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", "2026-01-05-budget-decided", "--to", "team-x", "--reason", "the decision matters"]);
  await withServer(root, async (base) => {
    const q = await post(base, "/api/queue/team-x/enqueue", {
      id: "2026-01-04-budget-pending", becauseOf: "2026-01-05-budget-decided", confirm: true,
    });
    assert.equal(q.status, 200);
    assert.equal((await post(base, "/api/queue/team-x/approve", { id: "2026-01-04-budget-pending", confirm: true })).status, 200);
    assert.equal((await post(base, "/api/queue/team-x/approve", { id: "2026-01-05-budget-decided", confirm: true })).status, 200);
  });
}));

test("dismiss sticks across a refetch", { timeout: 300_000 }, store(async (root) => {
  cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "maybe"]);
  await withServer(root, async (base) => {
    const res = await post(base, "/api/queue/team-x/dismiss", { id: ID, reason: "too detailed", confirm: true });
    assert.equal(res.status, 200);
    const after = (await (await fetch(`${base}/api/queue`)).json()) as { totalPending: number };
    assert.equal(after.totalPending, 0);
    assert.equal((await post(base, "/api/queue/team-x/approve", { id: ID, confirm: true })).status, 404);
  });
}));

test("every queue route answers 405 to the wrong method", { timeout: 300_000 }, store(async (root) => {
  await withServer(root, async (base) => {
    assert.equal((await post(base, "/api/queue", {})).status, 405);
    assert.equal((await fetch(`${base}/api/queue/team-x/approve`)).status, 405);
  });
}));

test("/queue-map.js is served", { timeout: 300_000 }, store(async (root) => {
  await withServer(root, async (base) => {
    const res = await fetch(`${base}/queue-map.js`);
    assert.equal(res.status, 200, "a missing STATIC entry reads like a syntax error in the console");
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  });
}));
