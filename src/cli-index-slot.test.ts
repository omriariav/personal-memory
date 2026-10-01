import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
