import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { z } from "zod";
import { MEMORY_DIR } from "./ingest.js";
import { similarity } from "./graph-maintenance.js";

/**
 * People profiles: display names and nicknames for person slugs, so a
 * question can say "Zhenya" and reach entries filed under `evgenia-ivanova`.
 * One file per person at `memory/people/<slug>.md` (frontmatter only) in the
 * PRIVATE store — real names never travel to shared graphs, and entries keep
 * slugs only. Written through `memory people alias …` (or edited like any
 * other private config); never scanned as entries.
 */

export const PEOPLE_DIRNAME = "people";

export function peopleDir(storeDir: string = MEMORY_DIR): string {
  return join(storeDir, PEOPLE_DIRNAME);
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lower-kebab slug");

export const PersonProfileSchema = z
  .object({
    slug,
    display_name: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type PersonProfile = z.infer<typeof PersonProfileSchema>;

/** lower → NFKD, diacritics stripped → non-alphanumerics to single spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function humanize(slugValue: string): string {
  return slugValue.replace(/-+/g, " ").trim();
}

export interface AliasIndex {
  /** normalized name → candidate slugs (more than one = ambiguous). */
  byName: Map<string, Set<string>>;
  /** Keys derivable from a slug itself (the slug, its humanized form): already matched lexically. */
  implicit: Set<string>;
  profiles: Map<string, PersonProfile>;
  /** Longest alias, in words — the detection window. */
  maxWords: number;
}

export function buildAliasIndex(profiles: PersonProfile[], knownPeople: Iterable<string>): AliasIndex {
  const byName = new Map<string, Set<string>>();
  const implicit = new Set<string>();
  let maxWords = 1;
  const add = (name: string, target: string, isImplicit = false) => {
    const n = normalizeName(name);
    if (!n) return;
    (byName.get(n) ?? byName.set(n, new Set()).get(n)!).add(target);
    if (isImplicit) implicit.add(n);
    maxWords = Math.max(maxWords, n.split(" ").length);
  };
  const slugs = new Set<string>(knownPeople);
  for (const p of profiles) slugs.add(p.slug);
  for (const s of slugs) add(humanize(s), s, true); // the raw slug normalizes to the same key
  for (const p of profiles) {
    if (p.display_name) add(p.display_name, p.slug);
    for (const a of p.aliases) add(a, p.slug);
  }
  return { byName, implicit, profiles: new Map(profiles.map((p) => [p.slug, p])), maxWords };
}

export async function loadPeopleProfiles(dir: string = peopleDir()): Promise<PersonProfile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: PersonProfile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const raw = await readFile(path, "utf8");
    const parsed = PersonProfileSchema.safeParse(matter(raw).data);
    if (!parsed.success) {
      throw new Error(
        `invalid people profile ${path}:\n` +
          parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
      );
    }
    const stem = basename(name, ".md");
    if (parsed.data.slug !== stem) {
      throw new Error(`people profile ${path}: filename '${stem}' must equal slug '${parsed.data.slug}'`);
    }
    out.push({ ...parsed.data, aliases: [...new Set(parsed.data.aliases)] });
  }
  return out;
}

export async function writePeopleProfile(profile: PersonProfile, dir: string = peopleDir()): Promise<string> {
  const p = PersonProfileSchema.parse({ ...profile, aliases: [...new Set(profile.aliases)] });
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${p.slug}.md`);
  const fm: Record<string, unknown> = { slug: p.slug };
  if (p.display_name) fm.display_name = p.display_name;
  fm.aliases = p.aliases;
  await writeFile(path, matter.stringify("", fm), "utf8");
  return path;
}

let cachedIndex: Promise<AliasIndex> | null = null;

/**
 * The process-wide alias index: profiles under memory/people/ plus every
 * person slug used by an entry (so bare slugs and their humanized forms
 * resolve even without a profile). Memoized — invalidate after writes.
 */
export function getAliasIndex(knownPeople: () => Promise<Iterable<string>>): Promise<AliasIndex> {
  if (!cachedIndex) {
    cachedIndex = (async () => buildAliasIndex(await loadPeopleProfiles(), await knownPeople()))();
  }
  return cachedIndex;
}

export function invalidateAliasIndex(): void {
  cachedIndex = null;
}

export interface Detection {
  /** Unambiguously resolved person slugs, in order of first mention. */
  slugs: string[];
  /** The subset reached through a real alias/display name — the text alone would not have matched the slug. */
  aliased: string[];
  /** normalized alias text → the slugs it named. */
  matched: Record<string, string[]>;
  /** Aliases that name more than one person (not resolved). */
  ambiguous: string[];
}

/** Sliding-window mention detection over normalized words, longest match first, non-overlapping. */
export function detectPeople(text: string, index: AliasIndex): Detection {
  const words = normalizeName(text).split(" ").filter(Boolean);
  const slugs: string[] = [];
  const aliased: string[] = [];
  const matched: Record<string, string[]> = {};
  const ambiguous: string[] = [];
  let i = 0;
  while (i < words.length) {
    let hit: { key: string; len: number } | null = null;
    for (let len = Math.min(index.maxWords, words.length - i); len >= 1; len--) {
      const key = words.slice(i, i + len).join(" ");
      if (index.byName.has(key)) {
        hit = { key, len };
        break;
      }
    }
    if (!hit) {
      i++;
      continue;
    }
    const targets = [...index.byName.get(hit.key)!].sort();
    matched[hit.key] = targets;
    if (targets.length === 1) {
      const s = targets[0]!;
      if (!slugs.includes(s)) slugs.push(s);
      if (!index.implicit.has(hit.key) && !aliased.includes(s)) aliased.push(s);
    } else if (!ambiguous.includes(hit.key)) {
      ambiguous.push(hit.key);
    }
    i += hit.len;
  }
  return { slugs, aliased, matched, ambiguous };
}

export type PersonResolution =
  | { slug: string; via: "slug" | "alias" | "fuzzy" }
  | { ambiguous: string[] };

/**
 * Resolve a `--person` value: exact slug → alias/display name → fuzzy slug
 * (edit similarity ≥ `fuzzyMin` against every known slug, unique best wins).
 */
export function resolvePerson(token: string, index: AliasIndex, fuzzyMin = 0.8): PersonResolution | null {
  const raw = token.trim();
  const key = normalizeName(raw);
  if (!key) return null;
  const known = new Set<string>();
  for (const set of index.byName.values()) for (const s of set) known.add(s);
  if (known.has(raw)) return { slug: raw, via: "slug" };
  const named = index.byName.get(key);
  if (named) {
    const targets = [...named].sort();
    if (targets.length === 1) return { slug: targets[0]!, via: "alias" };
    return { ambiguous: targets };
  }
  const probe = key.replace(/ /g, "-");
  let best: { slug: string; score: number }[] = [];
  for (const s of known) {
    const score = similarity(probe, s);
    if (score < fuzzyMin) continue;
    if (!best.length || score > best[0]!.score) best = [{ slug: s, score }];
    else if (score === best[0]!.score) best.push({ slug: s, score });
  }
  if (best.length === 1) return { slug: best[0]!.slug, via: "fuzzy" };
  if (best.length > 1) return { ambiguous: best.map((b) => b.slug).sort() };
  return null;
}
