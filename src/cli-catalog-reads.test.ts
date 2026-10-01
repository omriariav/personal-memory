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
    env: { ...process.env, MEMORY_EMBEDDINGS: "fake", MEMORY_QUIET: "1", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("list/person/promote/rules print the same text on the legacy slot and on a built next slot", { timeout: 300_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), "pm-cli-reads-"));
  try {
    seedStore(root);
    runInStore(root, `const s = await import(${STORE_MOD}); console.log(JSON.stringify(await s.syncIndex()));`, { MEMORY_INDEX_SLOT: "legacy" });
    cli(root, ["index", "--build", "next"]);
    const commands: string[][] = [
      ["list"],
      ["list", "--person", "boris-cohen", "--limit", "2"],
      ["list", "--graph", "team-x"],
      ["person", "boris-cohen"],
      ["promote", "candidates", "--to", "team-x"],
      ["rules", "list"],
    ];
    for (const args of commands) {
      const legacy = cli(root, [...args], { MEMORY_INDEX_SLOT: "legacy" });
      const next = cli(root, [...args], { MEMORY_INDEX_SLOT: "next" });
      assert.equal(next, legacy, `output of ${args.join(" ")}`);
    }
    assert.match(cli(root, ["list", "--index-slot", "next", "--type", "pending-decision"]), /Budget freeze pending.*\[resolved → 2026-01-05-budget-decided\]/);
    assert.match(cli(root, ["person", "chen-mizrahi", "--index-slot", "next"]), /Otter hiring loop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
