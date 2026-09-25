import type { QueryOrigin, QuerySpec, SearchFilters } from "./ranking.js";

/**
 * Query expansion for `recall`: the user's question (primary), the agent's
 * extra phrasings, and CLI-generated keyword / entity / filter phrasings —
 * every one becomes a retrieval list in the fusion, weighted by origin.
 */

export const ORIGIN_WEIGHTS: Readonly<Record<QueryOrigin, number>> = Object.freeze({
  primary: 1.25,
  agent: 1,
  cli: 0.6,
});

export const STOPWORDS: ReadonlySet<string> = new Set([
  "about",
  "after",
  "again",
  "also",
  "an",
  "and",
  "are",
  "as",
  "because",
  "been",
  "before",
  "did",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "our",
  "to",
  "the",
  "this",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
]);

function normalizeSpace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function keywordPhrase(s: string): string {
  const tokens = (s.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
  return normalizeSpace([...new Set(tokens)].join(" "));
}

export function entityPhrase(s: string): string {
  const entities = s.match(/\b[A-Z][A-Za-z0-9-]*(?:\s+[A-Z][A-Za-z0-9-]*)*/g) ?? [];
  return normalizeSpace([...new Set(entities.filter((e) => !STOPWORDS.has(e.toLowerCase())))].join(" "));
}

export function filterPhrase(filters: SearchFilters, keywords: string): string {
  const parts = [
    filters.type,
    filters.person,
    filters.team,
    filters.tag,
    filters.since ? `since ${filters.since}` : undefined,
    filters.until ? `until ${filters.until}` : undefined,
    keywords,
  ].filter(Boolean);
  return normalizeSpace(parts.join(" "));
}

function pushQuery(out: QuerySpec[], seen: Set<string>, text: string, origin: QueryOrigin): void {
  const normalized = normalizeSpace(text);
  const key = normalized.toLowerCase();
  if (!normalized || seen.has(key)) return;
  seen.add(key);
  out.push({ text: normalized, origin, weight: ORIGIN_WEIGHTS[origin] });
}

/**
 * @param resolvedPeople person slugs found in the question through the alias
 *   index (nicknames, display names); appended to the entity phrasing as the
 *   slug and its humanized form so both legs can match the entry's metadata.
 */
export function buildRecallQueries(
  positionals: string[],
  filters: SearchFilters = {},
  noExpand = false,
  resolvedPeople: string[] = [],
): QuerySpec[] {
  const primary = normalizeSpace(positionals[0] ?? "");
  if (!primary) return [];

  const seen = new Set<string>();
  const out: QuerySpec[] = [];
  pushQuery(out, seen, primary, "primary");
  for (const phrasing of positionals.slice(1)) pushQuery(out, seen, phrasing, "agent");

  if (!noExpand) {
    const keywords = keywordPhrase(primary);
    const people = [...new Set(resolvedPeople.flatMap((s) => [s, s.replace(/-+/g, " ")]))].join(" ");
    const entities = normalizeSpace(`${entityPhrase(primary)} ${people}`);
    pushQuery(out, seen, keywords, "cli");
    pushQuery(out, seen, entities, "cli");
    pushQuery(out, seen, filterPhrase(filters, normalizeSpace(`${keywords} ${people}`) || entities), "cli");
  }

  return out;
}
