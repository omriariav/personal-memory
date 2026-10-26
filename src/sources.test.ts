import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLookupCommand,
  loadSources,
  lookupDirectory,
  parseSource,
  reconcileSuggestions,
  saveSource,
  setSourceEnabled,
  writeSource,
  slugQuery,
  type DirectoryMatch,
  type LookupRunner,
  type SourceFile,
} from "./sources.js";
import {
  reconcileGraphAudit,
  type GraphMaintenanceAudit,
  type SlugSuggestion,
} from "./graph-maintenance.js";

const VALID = `---
name: people-directory
kind: person
enabled: true
lookup:
  command: "dir-lookup {query}"
---

# Guidance

Consult before minting.
`;

function makeLayers(): { templates: string; overrides: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "sources-test-"));
  const templates = join(root, "sources");
  const overrides = join(root, "memory", "sources");
  mkdirSync(templates, { recursive: true });
  mkdirSync(overrides, { recursive: true });
  return { templates, overrides, root };
}

// ---------------- parsing & schema ----------------

test("parseSource accepts a valid file and trims the body", () => {
  const { fm, body } = parseSource(VALID, "people-directory");
  assert.equal(fm.name, "people-directory");
  assert.equal(fm.kind, "person");
  assert.equal(fm.enabled, true);
  assert.equal(fm.lookup.command, "dir-lookup {query}");
  assert.ok(body.startsWith("# Guidance"));
});

test("parseSource rejects an unknown kind", () => {
  const raw = VALID.replace("kind: person", "kind: org");
  assert.throws(() => parseSource(raw, "people-directory"), /invalid source frontmatter/);
});

test("parseSource rejects a lookup command without {query}", () => {
  const raw = VALID.replace("dir-lookup {query}", "dir-lookup");
  assert.throws(() => parseSource(raw, "people-directory"), /\{query\} placeholder/);
});

test("parseSource rejects {query} wrapped in quotes (would neuter the CLI's quoting)", () => {
  for (const line of [
    `command: 'dir-lookup "{query}"'`,
    `command: "dir-lookup '{query}'"`,
  ]) {
    const raw = VALID.replace(`command: "dir-lookup {query}"`, line);
    assert.throws(() => parseSource(raw, "people-directory"), /unquoted token/);
  }
});

test("parseSource accepts {query} attached to an unquoted flag", () => {
  const raw = VALID.replace("dir-lookup {query}", "dir-lookup --name={query}");
  const { fm } = parseSource(raw, "people-directory");
  assert.equal(fm.lookup.command, "dir-lookup --name={query}");
});

test("parseSource rejects a missing lookup block and unknown keys", () => {
  const noLookup = `---\nname: x\nkind: person\n---\nbody`;
  assert.throws(() => parseSource(noLookup, "x"), /invalid source frontmatter/);
  const extraKey = VALID.replace("enabled: true", "enabled: true\nfetch: {}");
  assert.throws(() => parseSource(extraKey, "people-directory"), /invalid source frontmatter/);
});

test("parseSource rejects a name that doesn't match the filename stem", () => {
  assert.throws(() => parseSource(VALID, "other"), /must equal the filename stem/);
});

// ---------------- loading & override precedence ----------------

test("loadSources reads templates and collects per-file errors", async (t) => {
  const { templates, overrides, root } = makeLayers();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(templates, "people-directory.md"), VALID);
  writeFileSync(join(templates, "broken.md"), `---\nname: broken\n---\nbody`);

  const sources = await loadSources(templates, overrides);
  assert.deepEqual(
    sources.map((s) => [s.name, s.origin, Boolean(s.error)]),
    [["broken", "template", true], ["people-directory", "template", false]],
  );
  assert.match(sources[0]!.error!, /invalid source frontmatter/);
});

test("loadSources: an override fully replaces the template of the same name", async (t) => {
  const { templates, overrides, root } = makeLayers();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(templates, "people-directory.md"), VALID);
  writeFileSync(
    join(overrides, "people-directory.md"),
    VALID.replace("dir-lookup {query}", "real-lookup {query}"),
  );

  const sources = await loadSources(templates, overrides);
  assert.equal(sources.length, 1);
  assert.equal(sources[0]!.origin, "override");
  assert.equal(sources[0]!.fm!.lookup.command, "real-lookup {query}");
});

// ---------------- lookup mechanics ----------------

test("slugQuery turns a slug into a name query", () => {
  assert.equal(slugQuery("jane-doe"), "jane doe");
});

test("buildLookupCommand substitutes {query} shell-quoted, escaping quotes", () => {
  assert.equal(buildLookupCommand("dir-lookup {query}", "jane doe"), "dir-lookup 'jane doe'");
  assert.equal(buildLookupCommand("x {query} y {query}", "a'b"), `x 'a'\\''b' y 'a'\\''b'`);
});

const SOURCE = parseSource(VALID, "people-directory").fm;

test("lookupDirectory parses a JSON array of matches", async () => {
  const run: LookupRunner = async () => `[{"name": "Jane Doe", "id": "jdoe"}]`;
  assert.deepEqual(await lookupDirectory(SOURCE, "jane doe", run), [
    { name: "Jane Doe", id: "jdoe" },
  ]);
});

test("lookupDirectory degrades to null on failure, non-JSON, or bad shapes", async () => {
  const cases: LookupRunner[] = [
    async () => {
      throw new Error("command not found");
    },
    async () => "not json",
    async () => `{"name": "Jane"}`, // object, not array
    async () => `[{"id": "no-name"}]`, // element missing required name
    async () => `[{"name": ""}]`, // empty name
    async () => `[{"name": "Jane", "id": 5}]`, // non-string id
    async () => `[{"name": "Jane", "id": {"v": 1}}]`, // structured id
  ];
  for (const run of cases) {
    assert.equal(await lookupDirectory(SOURCE, "jane doe", run), null);
  }
});

// ---------------- suggestion reconciliation ----------------

function sourceFile(over: Partial<SourceFile> = {}): SourceFile {
  return {
    name: "people-directory",
    path: "/sources/people-directory.md",
    raw: VALID,
    origin: "template",
    fm: SOURCE,
    body: "",
    ...over,
  };
}

function suggestion(from: string, to: string, kind = "person") {
  return { kind, from, to, confidence: 0.72, reasons: ["edit similarity 0.90"] };
}

/** Fake directory keyed by the (unquoted) query embedded in the command. */
function fakeDirectory(byQuery: Record<string, DirectoryMatch[]>): LookupRunner {
  return async (command) => {
    const query = /'([^]*?)'/.exec(command)?.[1] ?? "";
    const matches = byQuery[query];
    if (!matches) throw new Error(`unexpected lookup: ${command}`);
    return JSON.stringify(matches);
  };
}

test("both slugs resolving to distinct identities dismisses the suggestion", async () => {
  const run = fakeDirectory({
    "dana m": [{ name: "Dana Magen", id: "dmagen" }],
    "dana n": [{ name: "Dana Nadler", id: "dnadler" }],
  });
  const { kept, dismissed } = await reconcileSuggestions([suggestion("dana-m", "dana-n")], [sourceFile()], run);
  assert.equal(kept.length, 0);
  assert.equal(dismissed.length, 1);
  assert.match(dismissed[0]!.reason, /Dana Magen \(dmagen\)/);
  assert.match(dismissed[0]!.reason, /distinct identities/);
});

test("both slugs resolving to the same identity boosts confidence with a reason", async () => {
  const jane = [{ name: "Jane Doe", id: "jdoe" }];
  const run = fakeDirectory({ "jane doe": jane, "jane d": jane });
  const { kept, dismissed } = await reconcileSuggestions([suggestion("jane-d", "jane-doe")], [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.confidence, 0.95);
  assert.match(kept[0]!.reasons.at(-1)!, /both resolve to Jane Doe \(jdoe\)/);
});

test("a boost never lowers an already-higher confidence", async () => {
  const jane = [{ name: "Jane Doe", id: "jdoe" }];
  const run = fakeDirectory({ "jane doe": jane, "jane d": jane });
  const high = { ...suggestion("jane-d", "jane-doe"), confidence: 0.98 };
  const { kept } = await reconcileSuggestions([high], [sourceFile()], run);
  assert.equal(kept[0]!.confidence, 0.98);
});

test("zero or multiple matches leave the suggestion untouched", async () => {
  const run = fakeDirectory({
    "dana m": [],
    "dana n": [
      { name: "Dana Nadler", id: "dnadler" },
      { name: "Dana Nachman", id: "dnachman" },
    ],
  });
  const input = [suggestion("dana-m", "dana-n")];
  const { kept, dismissed } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.deepEqual(kept, input);
});

test("a failing lookup command leaves the suggestion untouched", async () => {
  const run: LookupRunner = async () => {
    throw new Error("directory down");
  };
  const input = [suggestion("dana-m", "dana-n")];
  const { kept, dismissed } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.deepEqual(kept, input);
});

test("non-JSON lookup output leaves the suggestion untouched", async () => {
  const run: LookupRunner = async () => "ERROR: not logged in";
  const input = [suggestion("dana-m", "dana-n")];
  const { kept } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.deepEqual(kept, input);
});

test("disabled, invalid, or kind-mismatched sources are never consulted", async () => {
  const run: LookupRunner = async () => {
    throw new Error("must not run");
  };
  const disabled = sourceFile({ fm: { ...SOURCE, enabled: false } });
  const invalid = sourceFile({ fm: undefined, error: "invalid source frontmatter" });
  const teamOnly = sourceFile({ fm: { ...SOURCE, kind: "team" } });
  for (const sources of [[], [disabled], [invalid], [teamOnly]]) {
    const input = [suggestion("dana-m", "dana-n")];
    const { kept, dismissed } = await reconcileSuggestions(input, sources, run);
    assert.equal(dismissed.length, 0);
    assert.deepEqual(kept, input);
  }
});

test("tag suggestions pass through untouched even with a person source", async () => {
  const run: LookupRunner = async () => {
    throw new Error("must not run");
  };
  const input = [suggestion("k8s", "kubernetes", "tag")];
  const { kept } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.deepEqual(kept, input);
});

test("equal names without ids still boost (case/whitespace-insensitive)", async () => {
  const run = fakeDirectory({
    "jane d": [{ name: "jane  DOE " }],
    "jane doe": [{ name: "Jane Doe" }],
  });
  const { kept, dismissed } = await reconcileSuggestions([suggestion("jane-d", "jane-doe")], [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.equal(kept[0]!.confidence, 0.95);
});

test("differing names without ids never dismiss — no stable-id evidence", async () => {
  const run = fakeDirectory({
    "jane d": [{ name: "Jane Doe" }],
    "jane doe": [{ name: "Jane A. Doe" }],
  });
  const input = [suggestion("jane-d", "jane-doe")];
  const { kept, dismissed } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.deepEqual(kept, input); // unchanged: could be the same person
});

test("an id on only one side proves nothing — suggestion untouched", async () => {
  const run = fakeDirectory({
    "jane d": [{ name: "Jane Doe", id: "jdoe" }],
    "jane doe": [{ name: "Jane Doe" }],
  });
  const input = [suggestion("jane-d", "jane-doe")];
  const { kept, dismissed } = await reconcileSuggestions(input, [sourceFile()], run);
  assert.equal(dismissed.length, 0);
  assert.deepEqual(kept, input);
});

// ---------------- audit-level reconciliation ----------------

function fullSuggestion(from: string, to: string, confidence: number): SlugSuggestion {
  return {
    kind: "person",
    from,
    to,
    confidence,
    affectedEntries: 1,
    fromCount: 1,
    toCount: 2,
    sharedEntries: 0,
    lastSeen: "2026-07-01",
    reasons: ["edit similarity 0.90"],
  };
}

function makeAudit(suggestions: SlugSuggestion[]): GraphMaintenanceAudit {
  const suggestionCounts = { person: 0, team: 0, tag: 0 };
  for (const s of suggestions) suggestionCounts[s.kind]++;
  return {
    generatedAt: "2026-07-27T00:00:00Z",
    counts: { person: 4, team: 0, tag: 0 },
    suggestionCounts,
    suggestions,
  };
}

test("reconcileGraphAudit persists dismissals with reasons and fixes counts", async () => {
  const run = fakeDirectory({
    "dana m": [{ name: "Dana Magen", id: "dmagen" }],
    "dana n": [{ name: "Dana Nadler", id: "dnadler" }],
  });
  const audit = await reconcileGraphAudit(
    makeAudit([fullSuggestion("dana-m", "dana-n", 0.72)]),
    async () => [sourceFile()],
    run,
  );
  assert.equal(audit.suggestions.length, 0);
  assert.equal(audit.suggestionCounts.person, 0);
  assert.equal(audit.sourceDismissed?.length, 1);
  assert.equal(audit.sourceDismissed![0]!.from, "dana-m");
  assert.match(audit.sourceDismissed![0]!.sourceReason, /distinct identities/);
});

test("reconcileGraphAudit re-sorts after a confidence boost", async () => {
  const jane = [{ name: "Jane Doe", id: "jdoe" }];
  const run = fakeDirectory({ "jane d": jane, "jane doe": jane, "bob x": [], "bob y": [] });
  const audit = await reconcileGraphAudit(
    // sorted by confidence as analyzeGraphHygiene emits: 0.90 first
    makeAudit([fullSuggestion("bob-x", "bob-y", 0.9), fullSuggestion("jane-d", "jane-doe", 0.72)]),
    async () => [sourceFile()],
    run,
  );
  assert.deepEqual(
    audit.suggestions.map((s) => [s.from, s.confidence]),
    [["jane-d", 0.95], ["bob-x", 0.9]], // boosted pair overtakes
  );
  assert.equal(audit.suggestionCounts.person, 2);
  assert.equal(audit.sourceDismissed, undefined);
});

test("reconcileGraphAudit returns the audit unchanged when source loading throws", async () => {
  const input = makeAudit([fullSuggestion("dana-m", "dana-n", 0.72)]);
  const before = JSON.parse(JSON.stringify(input)) as GraphMaintenanceAudit;
  const audit = await reconcileGraphAudit(input, async () => {
    throw new Error("EACCES: permission denied, scandir");
  });
  assert.deepEqual(audit, before);
});

test("lookups are cached per slug across suggestions", async () => {
  let calls = 0;
  const jane = [{ name: "Jane Doe", id: "jdoe" }];
  const counting: LookupRunner = async (command) => {
    calls++;
    return fakeDirectory({ "jane doe": jane, "jane d": jane, "jane do": jane })(command);
  };
  await reconcileSuggestions(
    [suggestion("jane-d", "jane-doe"), suggestion("jane-do", "jane-doe")],
    [sourceFile()],
    counting,
  );
  assert.equal(calls, 3); // jane-doe looked up once, not twice
});

// ---------------- writing (UI/private-override layer) ----------------

test("writeSource writes the private override and loadSources resolves it", async () => {
  const { templates, overrides } = makeLayers();
  const path = await writeSource("people-directory", VALID, overrides);

  assert.equal(path, join(overrides, "people-directory.md"));
  assert.equal(readFileSync(path, "utf8"), VALID);

  const [file] = await loadSources(templates, overrides);
  assert.equal(file?.origin, "override");
  assert.equal(file?.fm?.lookup.command, "dir-lookup {query}");
});

test("writeSource rejects invalid content and writes nothing", async () => {
  const { overrides } = makeLayers();
  const bad = VALID.replace("kind: person", "kind: org");

  await assert.rejects(() => writeSource("people-directory", bad, overrides), /invalid source frontmatter/);
  assert.equal(existsSync(join(overrides, "people-directory.md")), false);
  assert.deepEqual(readdirSync(overrides), []);
});

test("writeSource builds the path from the name alone — a traversing name never writes", async () => {
  const { overrides } = makeLayers();
  await assert.rejects(() => writeSource("../escaped", VALID, overrides));
  assert.deepEqual(readdirSync(overrides), []);
});

test("writeSource leaves no .tmp file behind", async () => {
  const { overrides } = makeLayers();
  await writeSource("people-directory", VALID, overrides);
  assert.deepEqual(readdirSync(overrides), ["people-directory.md"]);
});

// ---------------- enable / disable (UI toggle) ----------------

test("setSourceEnabled flips the frontmatter flag and changes nothing else", async () => {
  const { templates, overrides } = makeLayers();
  writeFileSync(join(overrides, "people-directory.md"), VALID, "utf8");

  await setSourceEnabled("people-directory", false, templates, overrides);
  const off = readFileSync(join(overrides, "people-directory.md"), "utf8");
  assert.equal(off, VALID.replace("enabled: true", "enabled: false"));

  await setSourceEnabled("people-directory", true, templates, overrides);
  assert.equal(readFileSync(join(overrides, "people-directory.md"), "utf8"), VALID);
});

test("setSourceEnabled on a template writes an override, leaving the template untouched", async () => {
  const { templates, overrides } = makeLayers();
  const template = VALID.replace("enabled: true", "enabled: false");
  writeFileSync(join(templates, "people-directory.md"), template, "utf8");

  const { path, disabled } = await setSourceEnabled("people-directory", true, templates, overrides);

  assert.equal(path, join(overrides, "people-directory.md"));
  assert.deepEqual(disabled, []);
  assert.equal(readFileSync(join(templates, "people-directory.md"), "utf8"), template);
  const [file] = await loadSources(templates, overrides);
  assert.equal(file?.origin, "override");
  assert.equal(file?.fm?.enabled, true);
});

test("setSourceEnabled only rewrites frontmatter, never a body line that looks like it", async () => {
  const { templates, overrides } = makeLayers();
  const withDecoy = `${VALID}\nSet \`enabled: true\` once the command works.\n`;
  writeFileSync(join(overrides, "people-directory.md"), withDecoy, "utf8");

  await setSourceEnabled("people-directory", false, templates, overrides);

  const out = readFileSync(join(overrides, "people-directory.md"), "utf8");
  assert.match(out, /^enabled: false$/m);
  assert.ok(out.includes("Set `enabled: true` once the command works."));
});

test("setSourceEnabled inserts the flag when the file omits it", async () => {
  const { templates, overrides } = makeLayers();
  writeFileSync(join(overrides, "people-directory.md"), VALID.replace("enabled: true\n", ""), "utf8");

  await setSourceEnabled("people-directory", false, templates, overrides);

  const [file] = await loadSources(templates, overrides);
  assert.equal(file?.fm?.enabled, false);
});

test("setSourceEnabled refuses an unknown name and an unparseable file", async () => {
  const { templates, overrides } = makeLayers();
  await assert.rejects(() => setSourceEnabled("nope", true, templates, overrides), /no source named/);

  writeFileSync(join(overrides, "people-directory.md"), VALID.replace("kind: person", "kind: org"), "utf8");
  await assert.rejects(
    () => setSourceEnabled("people-directory", true, templates, overrides),
    /invalid source frontmatter/,
  );
});

// ---------------- at most one enabled source ----------------

const named = (name: string, enabled: boolean) =>
  VALID.replace("name: people-directory", `name: ${name}`).replace(
    "enabled: true",
    `enabled: ${enabled}`,
  );

test("enabling a source disables every other enabled one and reports which", async () => {
  const { templates, overrides } = makeLayers();
  writeFileSync(join(overrides, "acme-directory.md"), named("acme-directory", true), "utf8");
  writeFileSync(join(overrides, "people-directory.md"), named("people-directory", false), "utf8");

  const { disabled } = await setSourceEnabled("people-directory", true, templates, overrides);

  assert.deepEqual(disabled, ["acme-directory"]);
  const states = (await loadSources(templates, overrides)).map((s) => [s.name, s.fm?.enabled]);
  assert.deepEqual(states, [["acme-directory", false], ["people-directory", true]]);
});

test("enabling a source leaves an already-disabled one alone", async () => {
  const { templates, overrides } = makeLayers();
  writeFileSync(join(overrides, "acme-directory.md"), named("acme-directory", false), "utf8");
  writeFileSync(join(overrides, "people-directory.md"), named("people-directory", false), "utf8");

  const { disabled } = await setSourceEnabled("people-directory", true, templates, overrides);

  assert.deepEqual(disabled, []);
});

test("disabling a source never touches the others", async () => {
  const { templates, overrides } = makeLayers();
  writeFileSync(join(overrides, "acme-directory.md"), named("acme-directory", false), "utf8");
  writeFileSync(join(overrides, "people-directory.md"), named("people-directory", true), "utf8");

  const { disabled } = await setSourceEnabled("people-directory", false, templates, overrides);

  assert.deepEqual(disabled, []);
  const states = (await loadSources(templates, overrides)).map((s) => [s.name, s.fm?.enabled]);
  assert.deepEqual(states, [["acme-directory", false], ["people-directory", false]]);
});

test("the one-enabled rule holds across kinds, not just within one", async () => {
  const { templates, overrides } = makeLayers();
  writeFileSync(
    join(overrides, "acme-directory.md"),
    named("acme-directory", true).replace("kind: person", "kind: team"),
    "utf8",
  );
  writeFileSync(join(overrides, "people-directory.md"), named("people-directory", false), "utf8");

  const { disabled } = await setSourceEnabled("people-directory", true, templates, overrides);

  assert.deepEqual(disabled, ["acme-directory"]);
});

test("saveSource enforces the rule too — raw text can't sneak a second one on", async () => {
  const { templates, overrides } = makeLayers();
  writeFileSync(join(overrides, "acme-directory.md"), named("acme-directory", true), "utf8");

  const { disabled } = await saveSource(
    "people-directory",
    named("people-directory", true),
    templates,
    overrides,
  );

  assert.deepEqual(disabled, ["acme-directory"]);
  const states = (await loadSources(templates, overrides)).map((s) => [s.name, s.fm?.enabled]);
  assert.deepEqual(states, [["acme-directory", false], ["people-directory", true]]);
});

test("saveSource of a DISABLED file leaves an enabled one running", async () => {
  const { templates, overrides } = makeLayers();
  writeFileSync(join(overrides, "acme-directory.md"), named("acme-directory", true), "utf8");

  const { disabled } = await saveSource(
    "people-directory",
    named("people-directory", false),
    templates,
    overrides,
  );

  assert.deepEqual(disabled, []);
  assert.equal(
    (await loadSources(templates, overrides)).find((s) => s.name === "acme-directory")?.fm?.enabled,
    true,
  );
});
