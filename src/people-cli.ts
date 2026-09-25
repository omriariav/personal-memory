import { parseArgs } from "node:util";
import { relative } from "node:path";
import { loadAllEntries, ROOT } from "./ingest.js";
import { commitMemoryRepo } from "./memory-git.js";
import { slugUsage } from "./graph-maintenance.js";
import { knownPeople } from "./store.js";
import {
  buildAliasIndex,
  getAliasIndex,
  invalidateAliasIndex,
  loadPeopleProfiles,
  resolvePerson,
  writePeopleProfile,
  type PersonProfile,
} from "./people.js";

/**
 * `memory people …` — display names and nicknames for person slugs, kept in
 * memory/people/<slug>.md (private store only). Entries keep slugs; the
 * profiles let questions and `--person` use the names people actually say.
 */

const USAGE =
  'usage: memory people alias <slug> --add "Name" [--add "Nick"] [--remove "Name"] [--display "Full Name"] [--create]\n' +
  "       memory people list [--min-count N]\n" +
  "       memory people show <slug>";

export async function cmdPeople(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "alias") return alias(argv.slice(1));
  if (sub === "list") return list(argv.slice(1));
  if (sub === "show") return show(argv.slice(1));
  throw new Error(USAGE);
}

async function alias(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      add: { type: "string", multiple: true },
      remove: { type: "string", multiple: true },
      display: { type: "string" },
      create: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const slug = positionals[0];
  if (!slug || positionals.length !== 1) throw new Error(USAGE);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error(`'${slug}' is not a slug (lower-kebab)`);
  const adds = (values.add ?? []).map((s) => s.trim()).filter(Boolean);
  const removes = (values.remove ?? []).map((s) => s.trim()).filter(Boolean);
  if (!adds.length && !removes.length && !values.display) throw new Error(USAGE);

  const known = await knownPeople();
  const profiles = await loadPeopleProfiles();
  let profile = profiles.find((p) => p.slug === slug);
  if (!profile) {
    if (!known.has(slug) && !values.create) {
      throw new Error(`no entry mentions '${slug}' — pass --create to add a profile for a new person`);
    }
    profile = { slug, aliases: [] };
  }
  // A name already mapped to another person is a merge question, not an alias.
  const index = buildAliasIndex(profiles, known);
  for (const name of adds) {
    const hit = resolvePerson(name, index);
    const owner = hit && "slug" in hit && hit.via !== "fuzzy" ? hit.slug : undefined;
    if (owner && owner !== slug) {
      throw new Error(
        `'${name}' already names ${owner} — same person? merge with: memory slugs merge --kind person --from ${slug} --to ${owner}`,
      );
    }
  }
  const next: PersonProfile = {
    ...profile,
    ...(values.display ? { display_name: values.display } : {}),
    aliases: [...profile.aliases.filter((a) => !removes.includes(a)), ...adds.filter((a) => !profile!.aliases.includes(a))],
  };
  const path = await writePeopleProfile(next);
  invalidateAliasIndex();
  await commitMemoryRepo(`people: alias ${slug}`);
  console.log(`✓ ${relative(ROOT, path)}: ${describe(next)}`);
}

function describe(p: PersonProfile): string {
  const parts = [p.display_name ? `display "${p.display_name}"` : undefined, p.aliases.length ? `aliases ${p.aliases.map((a) => `"${a}"`).join(", ")}` : "no aliases"];
  return parts.filter(Boolean).join(" · ");
}

async function list(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { "min-count": { type: "string" } } });
  const minCount = values["min-count"] ? Number(values["min-count"]) : 1;
  const entries = await loadAllEntries();
  const usage = slugUsage(entries, "person").filter((s) => s.count >= minCount);
  const profiles = new Map((await loadPeopleProfiles()).map((p) => [p.slug, p]));
  for (const s of usage) {
    const p = profiles.get(s.slug);
    console.log(`${String(s.count).padStart(4)}  ${s.slug}${p ? `  ${describe(p)}` : ""}`);
  }
  const orphans = [...profiles.keys()].filter((slug) => !usage.some((u) => u.slug === slug));
  for (const slug of orphans) console.log(`   0  ${slug}  ${describe(profiles.get(slug)!)}  (profile only)`);
  console.log(`${usage.length} people across ${entries.length} entries · ${profiles.size} profile${profiles.size === 1 ? "" : "s"}`);
}

async function show(argv: string[]) {
  const slug = argv[0];
  if (!slug) throw new Error(USAGE);
  const index = await getAliasIndex(knownPeople);
  const r = resolvePerson(slug, index);
  if (!r) throw new Error(`no person matches '${slug}'`);
  if ("ambiguous" in r) throw new Error(`'${slug}' is ambiguous: ${r.ambiguous.join(", ")}`);
  const entries = await loadAllEntries();
  const mine = entries.filter((e) => e.people.includes(r.slug)).sort((a, b) => b.date.localeCompare(a.date));
  const p = index.profiles.get(r.slug);
  console.log(`${r.slug}${r.via !== "slug" ? `  (resolved from '${slug}' via ${r.via})` : ""}`);
  console.log(`  ${p ? describe(p) : "no profile — add one with: memory people alias " + r.slug + ' --add "Name"'}`);
  console.log(`  ${mine.length} entr${mine.length === 1 ? "y" : "ies"}${mine[0] ? `, last ${mine[0].date}` : ""}`);
}

/**
 * Resolve a `--person` value (or `person <slug>` positional) through the
 * alias index: exact slug, alias/display name, or a unique fuzzy slug.
 * Prints how it resolved when it was not the slug itself.
 */
export async function resolvePersonArg(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const index = await getAliasIndex(knownPeople);
  const r = resolvePerson(value, index);
  if (!r) throw new Error(`--person: no person matches '${value}' (try: memory people list)`);
  if ("ambiguous" in r) throw new Error(`--person '${value}' is ambiguous: ${r.ambiguous.join(", ")}`);
  if (r.via !== "slug") console.error(`--person resolved '${value}' → ${r.slug} (${r.via})`);
  return r.slug;
}
