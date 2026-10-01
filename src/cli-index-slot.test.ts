import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, STORE_MOD, runInStore, seedStore } from "./test-store.js";

function cli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** execFileSync's thrown error carries the child's stderr; the CLI prints `✗ <message>` there. */
function cliStderr(cwd: string, args: string[], env: Record<string, string> = {}): string {
  try {
    cli(cwd, args, env);
  } catch (err) {
    return String((err as { stderr?: unknown }).stderr ?? (err as Error).message);
  }
  throw new Error(`expected \`${args.join(" ")}\` to fail, but it succeeded`);
}

test("index --build: --rebuild and --reembed are a usage error, not silently ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-build-flags-"));
  try {
    const rebuild = cliStderr(root, ["index", "--build", "next", "--rebuild"]);
    assert.match(rebuild, /--rebuild applies only to a sync of the active slot/, "the flag names itself");
    assert.match(rebuild, /--force to replace an already-built slot/, "and points at the flag that does mean something here");

    assert.match(cliStderr(root, ["index", "--build", "next", "--reembed"]), /--reembed applies only to a sync/, "--reembed too");
    assert.match(cliStderr(root, ["index", "--build", "next", "--rebuild", "--reembed"]), /--rebuild and --reembed apply only/, "both at once");
    assert.match(cliStderr(root, ["index", "--dry-run"]), /--dry-run applies only to: memory index --build/, "the existing misuse error still stands");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Both streams of one CLI run — the resolver warning goes to stderr while the answer goes to stdout. */
function cliBoth(cwd: string, args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", join(REPO, "node_modules", "tsx", "dist", "loader.mjs"), join(REPO, "src", "cli.ts"), ...args], {
    cwd,
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `\`${args.join(" ")}\` failed: ${r.stderr}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

test("active.json naming a missing slot: recall still answers, and the fallback is announced once on stderr", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-gone-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); const r = await s.syncIndex(); console.log(JSON.stringify(r.slots.map((x) => x.slot)));`, {
      MEMORY_INDEX_SLOT: "legacy",
    });
    // The failure a restore produces: active.json survives, its slot does not.
    writeFileSync(join(root, ".index", "active.json"), JSON.stringify({ slot: "gone" }), "utf8");

    const run = cliBoth(root, ["recall", "otter hiring", "--format", "json"]);
    const report = JSON.parse(run.stdout);
    assert.equal(report.index.slot, "legacy", "the read falls back to the legacy root rather than failing");
    assert.ok(report.hits.length > 0, "and still answers from it");
    assert.match(run.stderr, /⚠ active\.json names slot 'gone'/, "stderr carries the warning the resolver returned");
    assert.match(run.stderr, /index --build gone/, "and the command that would rebuild the missing slot");

    const quiet = cliBoth(root, ["recall", "otter hiring", "--format", "json"], { MEMORY_QUIET: "1" });
    assert.ok(!/active\.json names slot/.test(quiet.stderr), `MEMORY_QUIET=1 silences it: ${quiet.stderr}`);

    // A WRITE resolves the same way and must announce it too, not acquire a slot quietly.
    const added = cliBoth(root, ["add", "--type", "note", "--title", "Fallback note", "--body", "written while active.json dangles"]);
    assert.match(added.stderr, /⚠ active\.json names slot 'gone'/, "the write path announces the fallback as well");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recall --index-slot: selects the slot, JSON reports it, unknown slot is a clear error", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-slot-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); const r = await s.syncIndex(); console.log(JSON.stringify(r.slots.map((x) => x.slot)));`, {
      MEMORY_INDEX_SLOT: "legacy",
    });
    cli(root, ["index", "--build", "next"]);

    const viaFlag = JSON.parse(cli(root, ["recall", "otter hiring", "--format", "json", "--index-slot", "next"]));
    assert.deepEqual(viaFlag.index, { slot: "next", format: 2 }, "--index-slot next must select the new-format slot");

    const viaEnv = JSON.parse(cli(root, ["recall", "otter hiring", "--format", "json"], { MEMORY_INDEX_SLOT: "next" }));
    assert.equal(viaEnv.index.slot, "next", "MEMORY_INDEX_SLOT selects the slot when no flag is given");

    const flagWins = JSON.parse(cli(root, ["recall", "otter hiring", "--format", "json", "--index-slot", "legacy"], { MEMORY_INDEX_SLOT: "next" }));
    assert.deepEqual(flagWins.index, { slot: "legacy", format: 1 }, "the flag outranks MEMORY_INDEX_SLOT");

    const err = cliStderr(root, ["recall", "otter", "--index-slot", "nope"]);
    assert.match(err, /unknown index slot 'nope'/, "a typo'd slot names itself");
    assert.match(err, /index --build nope/, "and the message carries the command that would build it");
    assert.ok(!/\n\s+at /.test(err), `a bad slot is one clear line, not a stack trace: ${err}`);

    const text = cli(root, ["query", "otter hiring loop", "--index-slot", "next"]);
    assert.match(text, /Otter hiring loop/, "query honours --index-slot too");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
