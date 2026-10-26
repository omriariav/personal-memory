import { readFile, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import matter from "gray-matter";
import { SourceSchema, type Source } from "./schema.js";
import { ROOT, MEMORY_DIR } from "./ingest.js";

/**
 * Reference-source files — one per authoritative directory the store may
 * consult, resolved from the same two layers as connectors:
 *
 * - `sources/<name>.md` — generic, git-tracked TEMPLATES. No personal
 *   config (real commands, org names) belongs here.
 * - `memory/sources/<name>.md` — private OVERRIDES, living inside the
 *   gitignored memory/ dir. When an override exists for a name it fully
 *   replaces the template.
 *
 * Sources never gate a write: they only make suggestions and repairs smarter
 * (maintenance slug hygiene, verify-then-mint slug creation). Every consumer
 * must degrade to today's behavior when a source is disabled, missing, or its
 * lookup fails.
 */
export const SOURCES_DIR = join(ROOT, "sources");
export const PRIVATE_SOURCES_DIR = join(MEMORY_DIR, "sources");

export interface SourceFile {
  /** Filename stem; present even when the file failed validation. */
  name: string;
  path: string;
  raw: string;
  /** Which layer the file was resolved from. */
  origin: "template" | "override";
  /** Parsed frontmatter + body — absent when `error` is set. */
  fm?: Source;
  body?: string;
  error?: string;
}

/**
 * Parse + validate one source file's text. Throws with a readable message
 * on YAML/schema errors or a frontmatter `name` that doesn't match the file.
 */
export function parseSource(raw: string, expectedName: string): { fm: Source; body: string } {
  const { data, content } = matter(raw);
  const parsed = SourceSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      `invalid source frontmatter:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
  }
  if (parsed.data.name !== expectedName) {
    throw new Error(
      `frontmatter name '${parsed.data.name}' must equal the filename stem '${expectedName}'`,
    );
  }
  return { fm: parsed.data, body: content.trim() };
}

const listMd = async (dir: string): Promise<string[]> =>
  existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".md")) : [];

/**
 * Load every source, merging the two layers: a private override in
 * `memory/sources/` wins over the template of the same name in `sources/`.
 * Per-file errors are collected, not thrown, so callers (CLI report) can
 * still open a broken file to fix it.
 */
export async function loadSources(
  templatesDir = SOURCES_DIR,
  overridesDir = PRIVATE_SOURCES_DIR,
): Promise<SourceFile[]> {
  const [templates, overrides] = await Promise.all([listMd(templatesDir), listMd(overridesDir)]);
  const overrideSet = new Set(overrides);
  const files = [
    ...templates
      .filter((f) => !overrideSet.has(f))
      .map((f) => ({ file: f, dir: templatesDir, origin: "template" as const })),
    ...overrides.map((f) => ({ file: f, dir: overridesDir, origin: "override" as const })),
  ].sort((a, b) => a.file.localeCompare(b.file));
  return Promise.all(
    files.map(async ({ file, dir, origin }) => {
      const name = file.slice(0, -3);
      const path = join(dir, file);
      const raw = await readFile(path, "utf8");
      try {
        const { fm, body } = parseSource(raw, name);
        return { name, path, raw, origin, fm, body };
      } catch (err) {
        return {
          name,
          path,
          raw,
          origin,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * Validate + atomically write a source file (tmp + rename in the same dir).
 * Always writes to the PRIVATE override layer (`memory/sources/`) so edits —
 * the real lookup command, which must never be committed — can't land in the
 * git-tracked templates. The path is built from `name` only: no caller-supplied
 * path ever reaches the filesystem. Returns the path written.
 */
export async function writeSource(
  name: string,
  raw: string,
  overridesDir = PRIVATE_SOURCES_DIR,
): Promise<string> {
  parseSource(raw, name); // throws on invalid content — nothing is written
  await mkdir(overridesDir, { recursive: true });
  const path = join(overridesDir, `${name}.md`);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, raw, "utf8");
  await rename(tmp, path);
  return path;
}

/**
 * Flip a source's `enabled` flag, preserving the file otherwise byte for byte
 * — the lookup command, the comments explaining it, and the agent guidance all
 * survive a toggle. Only the frontmatter block is rewritten, so a body line
 * that happens to read `enabled: true` is left alone; a file that omits the
 * flag gets one appended to its frontmatter. Writes through `writeSource`, so
 * the result is validated and lands in the private override layer like any
 * other edit. Returns the path written.
 */
export async function setSourceEnabled(
  name: string,
  enabled: boolean,
  templatesDir = SOURCES_DIR,
  overridesDir = PRIVATE_SOURCES_DIR,
): Promise<string> {
  const file = (await loadSources(templatesDir, overridesDir)).find((s) => s.name === name);
  if (!file) throw new Error(`no source named '${name}'`);
  if (file.error) throw new Error(file.error); // never rewrite a file we can't parse
  return writeSource(name, setFrontmatterFlag(file.raw, "enabled", enabled), overridesDir);
}

/** Rewrite `key: <bool>` inside the leading `---` block only, appending it when absent. */
function setFrontmatterFlag(raw: string, key: string, value: boolean): string {
  const fence = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!fence) throw new Error("source file has no frontmatter block");
  const [, open, inner, close] = fence;
  const line = new RegExp(`^${key}:.*$`, "m");
  const body = line.test(inner!)
    ? inner!.replace(line, `${key}: ${value}`)
    : `${inner}\n${key}: ${value}`;
  return `${open}${body}${close}${raw.slice(fence[0].length)}`;
}

export const relSource = (p: string) => relative(ROOT, p);

// ---------------- lookups ----------------

/** One row of a lookup command's JSON-array output. */
export interface DirectoryMatch {
  name: string;
  id?: string;
  title?: string;
  team?: string;
}

/** Runs a prepared lookup command, returns stdout. Injectable for tests. */
export type LookupRunner = (command: string) => Promise<string>;

const LOOKUP_TIMEOUT_MS = 10_000;
const execAsync = promisify(exec);

const defaultRunner: LookupRunner = async (command) => {
  const { stdout } = await execAsync(command, { timeout: LOOKUP_TIMEOUT_MS });
  return stdout;
};

/** A slug is the query: `jane-doe` → `jane doe` (directories index names). */
export const slugQuery = (slug: string) => slug.replace(/-/g, " ");

/** Substitute `{query}` shell-quoted — the user's command runs in a shell. */
export function buildLookupCommand(template: string, query: string): string {
  return template.replaceAll("{query}", `'${query.replace(/'/g, `'\\''`)}'`);
}

/**
 * Full shape check, not just `name`: reconciliation uses matches as NEGATIVE
 * evidence (a dismissal), so a malformed `id` (number, object, empty string)
 * must degrade the whole result to unresolved rather than flow into an
 * identity comparison.
 */
const isMatch = (m: unknown): m is DirectoryMatch => {
  if (typeof m !== "object" || m === null) return false;
  const { name, id, title, team } = m as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return false;
  for (const opt of [id, title, team]) {
    if (opt !== undefined && (typeof opt !== "string" || opt.trim() === "")) return false;
  }
  return true;
};

/**
 * Run one lookup. Returns the parsed matches, or null when the source is
 * unusable (command failed/timed out, non-JSON, not an array of {name})
 * — degradation, never a throw. `[]` means the directory answered "nobody".
 */
export async function lookupDirectory(
  source: Source,
  query: string,
  run: LookupRunner = defaultRunner,
): Promise<DirectoryMatch[] | null> {
  try {
    const parsed: unknown = JSON.parse(await run(buildLookupCommand(source.lookup.command, query)));
    if (!Array.isArray(parsed) || !parsed.every(isMatch)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------- slug-suggestion reconciliation ----------------

/** The slice of a merge suggestion that reconciliation reads and adjusts. */
export interface MergeSuggestionLike {
  kind: string;
  from: string;
  to: string;
  confidence: number;
  reasons: string[];
}

/** Directory confirmation is strong evidence — near the engine's 0.98 cap. */
const DIRECTORY_CONFIRMED_CONFIDENCE = 0.95;

const matchLabel = (m: DirectoryMatch) => (m.id ? `${m.name} (${m.id})` : m.name);

/** Display names compare loosely — case and whitespace are not identity. */
const normalizedName = (m: DirectoryMatch) => m.name.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * What two single-match lookups prove. Asymmetric on purpose: dismissing a
 * suggestion (negative evidence) requires two differing STABLE ids — display
 * names ("Jane Doe" vs "Jane A. Doe") may legitimately differ for the same person,
 * so without both ids the strongest verdict is a boost on equal names.
 */
function compareIdentities(a: DirectoryMatch, b: DirectoryMatch): "same" | "distinct" | "unknown" {
  if (a.id && b.id) return a.id === b.id ? "same" : "distinct";
  if (!a.id && !b.id && normalizedName(a) === normalizedName(b)) return "same";
  return "unknown";
}

/**
 * Check each person/team merge suggestion against the first enabled source of
 * its kind. A slug "resolves" only on exactly one match — zero or multiple
 * matches, a failed lookup, or no usable source all leave the suggestion
 * exactly as it was (hard requirement: sources degrade to today's behavior).
 *
 * - both slugs resolve to DISTINCT ids → the suggestion is dismissed
 *   (returned separately with the reason, for reporting)
 * - both resolve to the SAME identity → confidence is boosted and the reason
 *   is appended
 * - anything in between (missing ids + differing names) proves nothing →
 *   unchanged
 */
export async function reconcileSuggestions<T extends MergeSuggestionLike>(
  suggestions: T[],
  sources: SourceFile[],
  run: LookupRunner = defaultRunner,
): Promise<{ kept: T[]; dismissed: { suggestion: T; reason: string }[] }> {
  const usable = sources.filter((s) => !s.error && s.fm!.enabled);
  const sourceFor = (kind: string) => usable.find((s) => s.fm!.kind === kind);
  const kept: T[] = [];
  const dismissed: { suggestion: T; reason: string }[] = [];
  // One lookup per slug per source, however many suggestions mention it.
  const cache = new Map<string, Promise<DirectoryMatch[] | null>>();
  const lookup = (source: SourceFile, slug: string) => {
    const key = `${source.name}|${slug}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = lookupDirectory(source.fm!, slugQuery(slug), run);
      cache.set(key, hit);
    }
    return hit;
  };

  for (const s of suggestions) {
    const source = sourceFor(s.kind);
    if (!source) {
      kept.push(s);
      continue;
    }
    const [from, to] = await Promise.all([lookup(source, s.from), lookup(source, s.to)]);
    if (!from || !to || from.length !== 1 || to.length !== 1) {
      kept.push(s); // unresolved — behave exactly as without sources
      continue;
    }
    const [mf] = from as [DirectoryMatch];
    const [mt] = to as [DirectoryMatch];
    switch (compareIdentities(mf, mt)) {
      case "same":
        kept.push({
          ...s,
          confidence: Math.max(s.confidence, DIRECTORY_CONFIRMED_CONFIDENCE),
          reasons: [...s.reasons, `${source.name}: '${s.from}' and '${s.to}' both resolve to ${matchLabel(mf)}`],
        });
        break;
      case "distinct":
        dismissed.push({
          suggestion: s,
          reason: `${source.name}: '${s.from}' → ${matchLabel(mf)}, '${s.to}' → ${matchLabel(mt)} — distinct identities`,
        });
        break;
      case "unknown":
        kept.push(s); // ids missing/mixed — proves nothing either way
        break;
    }
  }
  return { kept, dismissed };
}
