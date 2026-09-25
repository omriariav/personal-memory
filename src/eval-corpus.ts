import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CASE_KINDS, type CaseKind, type EvalCase } from "./eval.js";

/**
 * Deterministic synthetic corpus for retrieval evaluation. The base loop and
 * the 20 needles are byte-identical to the original scripts/gen-corpus.ts
 * (seed 42, total 4000); the extra case families are appended AFTER it so
 * the base output never shifts. Bump GEN_VERSION whenever output changes.
 */
export const GEN_VERSION = 2; // 2: chain-NN-stale cases (entries unchanged since 1)

export { CASE_KINDS };

export interface GenOptions {
  root: string;
  total?: number;
  seed?: number;
  /** Case families to emit (default: all). Base entries + needle entries are always written. */
  families?: readonly CaseKind[];
}

export interface CorpusManifest {
  generator: number;
  seed: number;
  total: number;
  /** Total files written (base + needles + extra families). */
  entries: number;
  cases: EvalCase[];
  /** person slug → nicknames used in bodies (ground truth for alias support). */
  aliases: Record<string, string[]>;
}

// mulberry32 — tiny seeded PRNG, deterministic across runs
function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["ana", "boris", "chen", "dana", "eli", "fara", "gil", "hila", "ido", "jon", "karin", "lior", "maya", "noam", "orly", "pini", "rina", "shay", "tomer", "uri"];
const LAST = ["levi", "cohen", "mizrahi", "peretz", "biton", "dahan", "avraham", "friedman", "katz", "shapiro"];
const PEOPLE = FIRST.flatMap((f) => LAST.slice(0, 5).map((l) => `${f}-${l}`)); // 100
const TEAMS = ["demand-core", "ai-rnd", "supply", "platform", "data-eng", "infra", "growth", "mobile", "web", "sre", "bi", "creative"];
const TOPICS = ["latency", "budget", "roadmap", "hiring", "attrition", "migration", "incident", "rollout", "experiment", "pricing", "quota", "onboarding", "review", "promotion", "outage", "capacity", "vendor", "audit", "training", "offsite", "reorg", "okr", "forecast", "churn", "retention", "pipeline", "model", "dataset", "inference", "serving", "cache", "queue", "sharding", "kafka", "spark", "airflow", "dashboard", "alerting", "oncall", "runbook", "postmortem", "sla", "slo", "compliance", "gdpr", "security", "penetration", "backlog", "sprint", "velocity", "debt", "refactor", "monolith", "microservice", "gateway", "auth", "billing", "invoice", "payout", "revenue"]; // 60 tags
const TYPES = ["event", "decision", "1on1", "hiring", "incident", "achievement", "feedback", "meeting", "note"];
const VERBS = ["discussed", "shipped", "escalated", "postponed", "approved", "measured", "reviewed", "blocked", "unblocked", "planned"];
const OBJECTS = ["the quarterly plan", "a staged rollout", "the error budget", "capacity limits", "vendor pricing", "team staffing", "the on-call rotation", "an A/B test", "the data retention policy", "cross-team dependencies"];

/** Fact / query pairs with (nearly) disjoint vocabularies after stemming. */
const PARAPHRASES: { fact: string; query: string }[] = [
  { fact: "Retire the nightly batch job and move to streaming ingestion by March.", query: "when do we stop the overnight cron and switch to real-time data intake" },
  { fact: "Vendor contract renews automatically unless cancelled sixty days ahead.", query: "how much notice is needed to avoid the supplier agreement rolling over" },
  { fact: "New hires get a mentor for the first ninety days.", query: "buddy programme length for people who just joined" },
  { fact: "Error budget is exhausted; freeze feature launches this sprint.", query: "no more releases because reliability allowance is used up" },
  { fact: "Move the primary database to the new region before the audit.", query: "relocate the main datastore to another datacenter ahead of compliance review" },
  { fact: "Split the monolith checkout flow into two services next quarter.", query: "breaking up the single big purchase path into separate components" },
  { fact: "Raise the on-call stipend and shorten shifts to one week.", query: "paying pager duty more and making rotations briefer" },
  { fact: "Cache hit ratio dropped after the key format change.", query: "memoisation effectiveness fell once identifiers were renamed" },
  { fact: "Headcount plan approved: three backend engineers, one designer.", query: "how many people are we allowed to recruit and in which roles" },
  { fact: "Deprecate the legacy reporting API at the end of the year.", query: "sunset date for the old analytics endpoint" },
  { fact: "Customer churn spiked among small accounts after the price increase.", query: "did smaller clients leave when we raised what we charge" },
  { fact: "Training run failed because the dataset had duplicated rows.", query: "model fitting crashed due to repeated records in the corpus" },
];

const ALIASES: { slug: string; nick: string; topic: string; queryTopic: string }[] = [
  { slug: "evgenia-ivanova", nick: "Zhenya", topic: "the billing reconciliation script", queryTopic: "reconciliation" },
  { slug: "alexander-petrov", nick: "Sasha", topic: "the gateway timeout fix", queryTopic: "timeouts" },
  { slug: "margaret-holloway", nick: "Peggy", topic: "the quarterly forecast model", queryTopic: "forecast" },
  { slug: "william-carver", nick: "Bill", topic: "the airflow upgrade", queryTopic: "airflow" },
  { slug: "elizabeth-nakamura", nick: "Liz", topic: "the GDPR deletion pipeline", queryTopic: "deletion" },
  { slug: "robert-okafor", nick: "Bobby", topic: "the sharding rollout", queryTopic: "sharding" },
];

function fmYaml(fm: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`);
    else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function shiftDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86400e3).toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export async function generateCorpus(opts: GenOptions): Promise<CorpusManifest> {
  const root = resolve(opts.root);
  const total = opts.total ?? 4000;
  const seed = opts.seed ?? 42;
  const families = new Set<CaseKind>(opts.families ?? CASE_KINDS);

  if (existsSync(join(root, ".git")) || existsSync(join(root, "package.json"))) {
    throw new Error("refusing to generate a synthetic corpus inside a repo/package — use an empty scratch dir");
  }

  const rand = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const pickN = <T>(xs: T[], n: number): T[] => {
    const out = new Set<T>();
    while (out.size < Math.min(n, xs.length)) out.add(pick(xs));
    return [...out];
  };
  const dateAt = (i: number, n: number): string => {
    // spread evenly over 2023-07-01 .. 2026-06-30, with jitter
    const start = Date.UTC(2023, 6, 1);
    const end = Date.UTC(2026, 5, 30);
    const t = start + ((end - start) * i) / n + rand() * 86400e3 * 3;
    return new Date(Math.min(t, end)).toISOString().slice(0, 10);
  };

  let written = 0;
  async function writeMd(id: string, date: string, fm: Record<string, unknown>, body: string) {
    const [y, m] = date.split("-");
    const dir = join(root, "memory", "entries", y!, m!);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}.md`), `${fmYaml(fm)}\n\n${body}\n`, "utf8");
    written++;
  }

  const cases: EvalCase[] = [];
  const aliases: Record<string, string[]> = {};

  // --- base loop (unchanged from the original generator) -------------------
  const base: { id: string; date: string; type: string; title: string; team: string }[] = [];
  for (let i = 0; i < total; i++) {
    const date = dateAt(i, total);
    const tags = pickN(TOPICS, 1 + Math.floor(rand() * 3));
    const people = pickN(PEOPLE, 1 + Math.floor(rand() * 3));
    const team = pick(TEAMS);
    const type = pick(TYPES);
    const title = `${tags[0]} ${pick(VERBS)} with ${people[0]} #${String(i).padStart(4, "0")}`;
    const id = `${date}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)}`;
    const body = [
      `${people.join(", ")} ${pick(VERBS)} ${pick(OBJECTS)} for ${team} — focus on ${tags.join(", ")}.`,
      `Context: ${pick(OBJECTS)} was ${pick(VERBS)} last cycle; ${pick(TOPICS)} and ${pick(TOPICS)} remain open.`,
      rand() > 0.5 ? `Next step: revisit ${pick(TOPICS)} with ${pick(PEOPLE)} before end of quarter.` : `No follow-up needed.`,
    ].join("\n\n");
    await writeMd(id, date, { id, date, type, title, people, teams: [team], tags }, body);
    base.push({ id, date, type, title, team });
  }

  // --- needles: unique fact + a rare person who appears nowhere else --------
  const needles: { id: string; person: string; fact: string; date: string; team: string; n: number }[] = [];
  for (let n = 0; n < 20; n++) {
    const person = `needle-person-${pad2(n)}`;
    const fact = `codeword-${n}-zephyr-quokka`;
    const date = dateAt(Math.floor(((n * 190 + 50) * total) / 4000), total);
    const title = `Rare decision involving ${person} (${fact})`;
    const id = `${date}-needle-${pad2(n)}`;
    const body = `${person} made a rare call: adopt ${fact} as the internal protocol name.\n\nThis is the only entry mentioning ${fact}; it must always be retrievable.`;
    const team = pick(TEAMS);
    await writeMd(id, date, { id, date, type: "decision", title, people: [person], teams: [team], tags: ["needle-check"] }, body);
    needles.push({ id, person, fact, date, team, n });
  }
  await writeFile(
    join(root, "needles.json"),
    JSON.stringify(needles.map(({ id, person, fact, date }) => ({ id, person, fact, date })), null, 2),
    "utf8",
  );

  if (families.has("needle")) {
    for (const nd of needles) {
      cases.push({ id: `needle-${pad2(nd.n)}-fact`, kind: "needle", query: nd.fact, expect: [nd.id], passAtK: 1 });
      cases.push({ id: `needle-${pad2(nd.n)}-person`, kind: "needle", query: `what did ${nd.person} decide`, expect: [nd.id], passAtK: 5 });
      cases.push({
        id: `needle-${pad2(nd.n)}-filter`,
        kind: "needle",
        query: "rare decision",
        filters: { person: nd.person },
        expect: [nd.id],
        passAtK: 1,
        expectExhaustive: true,
      });
    }
    cases.push({
      id: "needle-all-tag",
      kind: "needle",
      query: "internal protocol name",
      filters: { tag: "needle-check" },
      expect: needles.map((n) => n.id),
      k: 40,
      passAtK: 40,
      expectExhaustive: true,
    });
  }

  // --- near-duplicate distractors ------------------------------------------
  if (families.has("dup")) {
    for (const nd of needles.slice(0, 10)) {
      const dups: string[] = [];
      for (const suffix of ["quail", "quoll"]) {
        const fact = `codeword-${nd.n}-zephyr-${suffix}`;
        const person = pick(PEOPLE);
        const id = `${nd.date}-needle-${pad2(nd.n)}-dup-${suffix}`;
        const title = `Rare decision involving ${person} (${fact})`;
        const body = `${person} made a rare call: adopt ${fact} as the internal protocol name.\n\nThis entry is a near-duplicate distractor for ${fact}.`;
        await writeMd(id, nd.date, { id, date: nd.date, type: "decision", title, people: [person], teams: [nd.team], tags: ["needle-check"] }, body);
        dups.push(id);
      }
      cases.push({
        id: `needle-${pad2(nd.n)}-vs-dup`,
        kind: "dup",
        query: nd.fact,
        expect: [nd.id],
        passAtK: 1,
        mustNotOutrank: dups.map((d) => [d, nd.id] as [string, string]),
      });
    }
  }

  // --- paraphrase needles ----------------------------------------------------
  if (families.has("paraphrase")) {
    for (const [i, p] of PARAPHRASES.entries()) {
      const date = dateAt(Math.floor(rand() * total), total);
      const people = pickN(PEOPLE, 2);
      const id = `${date}-paraphrase-${pad2(i)}`;
      const title = `Team update #${pad2(i)}`;
      const body = `${p.fact}\n\n${people.join(" and ")} ${pick(VERBS)} ${pick(OBJECTS)}; nothing else changed.`;
      await writeMd(id, date, { id, date, type: "note", title, people, teams: [pick(TEAMS)], tags: [pick(TOPICS)] }, body);
      cases.push({ id: `paraphrase-${pad2(i)}`, kind: "paraphrase", query: p.query, expect: [id], passAtK: 10 });
    }
  }

  // --- alias needles (nickname in body only) ---------------------------------
  if (families.has("alias")) {
    for (const [i, a] of ALIASES.entries()) {
      const date = dateAt(Math.floor(rand() * total), total);
      const id = `${date}-alias-${pad2(i)}`;
      const title = `Update on ${a.topic}`;
      const body = `${a.nick} finished ${a.topic} and handed it over.\n\nFollow-up owner: ${a.nick}.`;
      await writeMd(id, date, { id, date, type: "achievement", title, people: [a.slug], teams: [pick(TEAMS)], tags: [pick(TOPICS)] }, body);
      aliases[a.slug] = [a.nick];
      cases.push({
        id: `alias-${pad2(i)}`,
        kind: "alias",
        query: `what did ${a.nick} work on`,
        expect: [id],
        passAtK: 10,
        xfail: true,
        notes: `needs alias ${a.nick} → ${a.slug}; topic ${a.queryTopic} deliberately absent from the query`,
      });
    }
  }

  // --- follows chains: note → pending-decision → decision --------------------
  if (families.has("chain")) {
    for (let n = 0; n < 10; n++) {
      const topic = `helix-${pad2(n)}`;
      const d2 = dateAt(Math.floor(total * 0.3 + rand() * total * 0.6), total);
      const d1 = shiftDays(d2, -40);
      const d0 = shiftDays(d2, -90);
      const person = pick(PEOPLE);
      const team = pick(TEAMS);
      const note = `${d0}-${topic}-note`;
      const pending = `${d1}-${topic}-pending`;
      const decision = `${d2}-${topic}-decision`;
      await writeMd(note, d0, { id: note, date: d0, type: "note", title: `${topic} vendor proposal`, people: [person], teams: [team], tags: ["vendor", topic] },
        `Proposal for ${topic}: renew with vendor Alpha for another year.\n\nOpen question: pricing and support tiers.`);
      await writeMd(pending, d1, { id: pending, date: d1, type: "pending-decision", title: `${topic} vendor decision pending`, people: [person], teams: [team], tags: ["vendor", topic], follows: [note] },
        `Decision pending on the ${topic} vendor: Alpha renewal versus switching to Beta.\n\nWaiting on the security review.`);
      await writeMd(decision, d2, { id: decision, date: d2, type: "decision", title: `${topic} vendor decided`, people: [person], teams: [team], tags: ["vendor", topic], follows: [pending] },
        `Decided: ${topic} moves to vendor Beta. The Alpha renewal is cancelled.\n\nMigration starts next month.`);
      cases.push({
        id: `chain-${pad2(n)}-latest`,
        kind: "chain",
        query: `which vendor did we pick for ${topic}`,
        expect: { [decision]: 3, [pending]: 1, [note]: 1 },
        mustNotOutrank: [[note, decision], [pending, decision]],
        passAtK: 10,
      });
      cases.push({
        id: `chain-${pad2(n)}-open`,
        kind: "chain",
        query: `is the ${topic} vendor decision still open`,
        expect: [pending],
        passAtK: 5,
        expectChain: { id: pending, status: "resolved", latest: decision },
      });
      // Asked in the STALE member's own words: the current state must still win.
      cases.push({
        id: `chain-${pad2(n)}-stale`,
        kind: "chain",
        query: `waiting on the security review for the ${topic} Alpha renewal versus Beta`,
        expect: { [decision]: 3, [pending]: 2 },
        mustNotOutrank: [[pending, decision]],
        passAtK: 10,
        notes: "query paraphrases the superseded pending-decision; the decision that closed it must rank above it",
      });
    }
  }

  // --- filter cases ------------------------------------------------------------
  if (families.has("filter")) {
    // one calendar month of decisions from the base loop: the exact id set is known
    const mid = base[Math.floor(base.length / 2)]!;
    const month = mid.date.slice(0, 7);
    const since = `${month}-01`;
    const until = `${month}-31`;
    const decisions = base.filter((b) => b.type === "decision" && b.date >= since && b.date <= until).map((b) => b.id);
    cases.push({
      id: "filter-type-window",
      kind: "filter",
      query: "decision",
      filters: { type: "decision", since, until },
      expect: decisions,
      k: 200,
      passAtK: 200,
      expectExhaustive: true,
    });
    const nd = needles[3]!;
    cases.push({
      id: "filter-team-large",
      kind: "filter",
      query: nd.fact,
      filters: { team: nd.team },
      expect: [nd.id],
      passAtK: 1,
      expectExhaustive: false,
      notes: "team scope is large (> complete limit), so the SQL-prefiltered non-exhaustive path is exercised",
    });
    cases.push({ id: "filter-empty", kind: "filter", query: "anything", filters: { person: "nobody-here" }, expect: [] });
  }

  // --- title-exact sanity ------------------------------------------------------
  if (families.has("title")) {
    for (let i = 0; i < 20; i++) {
      const b = base[Math.floor(rand() * base.length)]!;
      cases.push({ id: `title-${pad2(i)}`, kind: "title", query: b.title, expect: [b.id], passAtK: 1 });
    }
  }

  const manifest: CorpusManifest = { generator: GEN_VERSION, seed, total, entries: written, cases, aliases };
  await writeFile(join(root, "eval-cases.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}
