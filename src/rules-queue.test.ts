import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, seedStore } from "./test-store.js";

/**
 * The behaviour change: a standing rule, and an explicitly named graph at
 * capture, both PROPOSE. Neither writes into a shared store any more. These
 * assert the absence of a published file as much as the presence of a row —
 * the thing that would be wrong is a silent publish.
 */

function cli(cwd: string, args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args],
    { cwd, env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function withStore(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pm-rules-queue-")));
  try {
    seedStore(root);
    cli(root, ["index"]);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Write a standing rule sending `tag` to team-x. */
function rule(root: string, tag: string, mode: "copy" | "move" = "copy"): void {
  mkdirSync(join(root, "memory", "graphs"), { recursive: true });
  writeFileSync(
    join(root, "memory", "graphs", "rules.json"),
    JSON.stringify({ version: 1, rules: [{ match: { tag }, graph: "team-x", mode }] }, null, 2),
    "utf8",
  );
}

const sharedDir = (root: string) => join(root, "memory-graphs", "team-x", "entries");

test("a capture matching a rule is queued, not published", { timeout: 300_000 }, () => {
  withStore((root) => {
    rule(root, "migration");
    const out = cli(root, ["add", "--title", "Cutover plan", "--type", "decision", "--tags", "migration", "--date", "2026-02-01", "--body", "We will cut over on the 14th."]);
    assert.match(out, /→ rule: queued/);
    assert.doesNotMatch(out, /copied/);

    const list = cli(root, ["queue", "list", "--graph", "team-x"]);
    assert.match(list, /2026-02-01-cutover-plan/);
    assert.match(list, /rules: matched a standing distribution rule/);
    assert.equal(
      existsSync(join(sharedDir(root), "2026", "02", "2026-02-01-cutover-plan.md")),
      false,
      "a rule proposes; it does not publish",
    );
  });
});

test("rules apply backfills into the queue, and --dry-run says so", { timeout: 300_000 }, () => {
  withStore((root) => {
    rule(root, "budget");
    const dry = cli(root, ["rules", "apply", "--dry-run"]);
    assert.match(dry, /would queue 2026-01-02-quokka-budget → team-x \(copy\)/);
    assert.match(dry, /nothing queued/);

    const applied = cli(root, ["rules", "apply"]);
    assert.match(applied, /queued 2026-01-02-quokka-budget → team-x/);
    assert.match(applied, /Review them: memory queue list/);
    assert.equal(existsSync(join(sharedDir(root), "2026", "01", "2026-01-02-quokka-budget.md")), false);
  });
});

test("a move rule queues a move, which approving then performs", { timeout: 300_000 }, () => {
  withStore((root) => {
    rule(root, "needle", "move");
    cli(root, ["rules", "apply"]);
    const parsed = JSON.parse(cli(root, ["queue", "list", "--graph", "team-x", "--json"])) as {
      items: { id: string; action: string }[];
    };
    assert.equal(parsed.items[0]!.id, "2026-01-06-rare-codeword");
    assert.equal(parsed.items[0]!.action, "move", "the rule's mode becomes the proposed action");

    cli(root, ["queue", "approve", "2026-01-06-rare-codeword", "--graph", "team-x"]);
    assert.equal(
      existsSync(join(root, "memory", "entries", "2026", "01", "2026-01-06-rare-codeword.md")),
      false,
      "a move leaves no private home — that is what the user approved",
    );
  });
});

test("add --graph homes the entry privately and queues it for that graph", { timeout: 300_000 }, () => {
  withStore((root) => {
    const out = cli(root, ["add", "--title", "Kafka choice", "--type", "decision", "--graph", "team-x", "--date", "2026-02-02", "--body", "Kafka it is."]);
    assert.match(out, /queued for 'team-x' review/);

    const id = "2026-02-02-kafka-choice";
    assert.equal(
      existsSync(join(root, "memory", "entries", "2026", "02", `${id}.md`)),
      true,
      "the memory has a private home — the old --graph wrote nowhere else",
    );
    assert.equal(existsSync(join(sharedDir(root), "2026", "02", `${id}.md`)), false);
    assert.match(cli(root, ["queue", "list", "--graph", "team-x"]), new RegExp(id));
    assert.match(cli(root, ["queue", "show", id, "--graph", "team-x"]), /you asked for this graph/);
  });
});

test("approving the queued candidate is what finally publishes it", { timeout: 300_000 }, () => {
  withStore((root) => {
    rule(root, "migration");
    cli(root, ["add", "--title", "Cutover plan", "--type", "decision", "--tags", "migration", "--date", "2026-02-01", "--body", "We will cut over on the 14th."]);
    cli(root, ["queue", "approve", "2026-02-01-cutover-plan", "--graph", "team-x"]);
    assert.equal(existsSync(join(sharedDir(root), "2026", "02", "2026-02-01-cutover-plan.md")), true);
    assert.match(cli(root, ["queue", "list", "--graph", "team-x"]), /nothing pending/);
  });
});

test("an update does not re-queue, and a mismatched --graph is still refused", { timeout: 300_000 }, () => {
  withStore((root) => {
    const id = "2026-01-03-otter-hiring";
    const out = cli(root, ["add", "--update", id, "--title", "Otter hiring loop", "--type", "hiring", "--graph", "team-x", "--body", "Revised notes."]);
    assert.match(out, /--graph team-x ignored/, "a re-capture never relocates an entry");
    assert.match(cli(root, ["queue", "list", "--graph", "team-x"]), /nothing pending/);
  });
});
