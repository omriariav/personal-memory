import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, seedStore } from "./test-store.js";

/**
 * `memory queue` — the surface both a human and a sweep routine drive. The
 * JSON mode is a contract: the chat skills read it to walk the queue, so its
 * shape and its silences (no summary bodies in `list`) are tested, not
 * incidental.
 */

const ID = "2026-01-03-otter-hiring";

function cli(cwd: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args],
    { cwd, env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** stdout + stderr for a command expected to fail. */
function cliFails(cwd: string, args: string[]): { out: string; err: string } {
  try {
    cli(cwd, args);
    return { out: "", err: "" };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string };
    return { out: String(x.stdout ?? ""), err: String(x.stderr ?? "") };
  }
}

function withStore(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-queue-cli-")));
  try {
    seedStore(root);
    cli(root, ["index"]);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const sharedFile = (root: string) =>
  join(root, "memory-graphs", "team-x", "entries", "2026", "01", `${ID}.md`);

test("queue add proposes without publishing, and list shows the reasoning", { timeout: 300_000 }, () => {
  withStore((root) => {
    const out = cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "architecture the group owns", "--proposed-by", "codex-nightly"]);
    assert.match(out, /queued .* → team-x/);
    assert.equal(existsSync(sharedFile(root)), false, "proposing is not publishing");

    const list = cli(root, ["queue", "list", "--graph", "team-x"]);
    assert.match(list, new RegExp(ID));
    assert.match(list, /codex-nightly: architecture the group owns/);
    assert.match(list, /team-x: 1 pending/);
  });
});

test("queue add --summary-file offers redacted wording, kept out of list output", { timeout: 300_000 }, () => {
  withStore((root) => {
    const draft = join(root, "draft.txt");
    writeFileSync(draft, "Only the shareable gist.\n", "utf8");
    cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "needs redaction", "--summary-file", draft]);

    const list = cli(root, ["queue", "list", "--graph", "team-x", "--json"]);
    const parsed = JSON.parse(list) as { items: { hasSummary: boolean; summary?: string }[] };
    assert.equal(parsed.items[0]!.hasSummary, true);
    assert.equal(parsed.items[0]!.summary, undefined, "list never sprays drafted redactions into logs");

    const show = cli(root, ["queue", "show", ID, "--graph", "team-x"]);
    assert.match(show, /Only the shareable gist/, "show is where the wording lives");
  });
});

test("queue approve publishes the entry's own wording by default", { timeout: 300_000 }, () => {
  withStore((root) => {
    cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "fine as-is"]);
    const out = cli(root, ["queue", "approve", ID, "--graph", "team-x"]);
    assert.match(out, /copied .* → team-x/);
    assert.match(readFileSync(sharedFile(root), "utf8"), /interviews and offers/);
    assert.match(cli(root, ["queue", "list", "--graph", "team-x"]), /nothing pending/);
  });
});

test("queue approve --summary publishes the proposed wording instead", { timeout: 300_000 }, () => {
  withStore((root) => {
    const draft = join(root, "draft.txt");
    writeFileSync(draft, "Only the shareable gist.\n", "utf8");
    cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "needs redaction", "--summary-file", draft]);
    const out = cli(root, ["queue", "approve", ID, "--graph", "team-x", "--summary"]);
    assert.match(out, /the approved summary, not the entry's own wording/);

    const published = readFileSync(sharedFile(root), "utf8");
    assert.match(published, /Only the shareable gist/);
    assert.doesNotMatch(published, /interviews and offers/);
  });
});

test("queue dismiss sticks, and re-proposing it is refused", { timeout: 300_000 }, () => {
  withStore((root) => {
    cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "maybe"]);
    cli(root, ["queue", "dismiss", ID, "--graph", "team-x", "--reason", "too detailed"]);
    assert.match(cli(root, ["queue", "list", "--graph", "team-x"]), /nothing pending/);

    const again = cliFails(root, ["queue", "add", ID, "--to", "team-x", "--reason", "trying again"]);
    assert.match(again.out, /already declined/);
    // --force is the deliberate way back in.
    assert.match(cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "new angle", "--force"]), /queued/);
  });
});

test("queue list --json carries the per-graph watermarks a routine resumes from", { timeout: 300_000 }, () => {
  withStore((root) => {
    cli(root, ["queue", "sweep", "--graph", "team-x", "--through", "2026-02-01"]);
    const parsed = JSON.parse(cli(root, ["queue", "list", "--graph", "team-x", "--json"])) as {
      graphs: { graph: string; sweptThrough: string; pending: number }[];
    };
    assert.equal(parsed.graphs[0]!.graph, "team-x");
    assert.equal(parsed.graphs[0]!.sweptThrough, "2026-02-01");
    assert.equal(parsed.graphs[0]!.pending, 0);
  });
});

test("queue sweep refuses to rewind a watermark unless forced", { timeout: 300_000 }, () => {
  withStore((root) => {
    cli(root, ["queue", "sweep", "--graph", "team-x", "--through", "2026-03-01"]);
    const back = cliFails(root, ["queue", "sweep", "--graph", "team-x", "--through", "2026-01-01"]);
    assert.match(back.err, /would move it backwards/);
    assert.match(cli(root, ["queue", "sweep", "--graph", "team-x", "--through", "2026-01-01", "--force"]), /swept through 2026-01-01/);
  });
});

test("a blocked candidate is listed with its blockers and refused on approve", { timeout: 300_000 }, () => {
  withStore((root) => {
    cli(root, ["queue", "add", "2026-01-05-budget-decided", "--to", "team-x", "--reason", "the decision matters"]);
    assert.match(cli(root, ["queue", "list", "--graph", "team-x"]), /blocked by 2026-01-04-budget-pending/);
    const res = cliFails(root, ["queue", "approve", "2026-01-05-budget-decided", "--graph", "team-x"]);
    assert.match(res.err, /references entries that are not in 'team-x'/);
  });
});

test("--state narrows the list to what needs attention", { timeout: 300_000 }, () => {
  withStore((root) => {
    cli(root, ["queue", "add", ID, "--to", "team-x", "--reason", "ready one"]);
    cli(root, ["queue", "add", "2026-01-05-budget-decided", "--to", "team-x", "--reason", "blocked one"]);
    const blocked = cli(root, ["queue", "list", "--graph", "team-x", "--state", "blocked", "--json"]);
    const ids = (JSON.parse(blocked) as { items: { id: string }[] }).items.map((i) => i.id);
    assert.deepEqual(ids, ["2026-01-05-budget-decided"]);
  });
});
