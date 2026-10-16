import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecallQueries, ORIGIN_WEIGHTS } from "./recall-queries.js";

test("origin weights: primary 1.25, agent 1, cli 0.6", () => {
  assert.deepEqual(ORIGIN_WEIGHTS, { primary: 1.25, agent: 1, cli: 0.6 });
});

test("empty primary yields no queries", () => {
  assert.deepEqual(buildRecallQueries([]), []);
  assert.deepEqual(buildRecallQueries(["   "]), []);
});

test("primary + agent phrasings + cli keyword/entity/filter expansions, weighted by origin", () => {
  const qs = buildRecallQueries(
    ["What did Jane Doe decide about the Acme migration?", "Jane's Acme migration decision"],
    { person: "jane-doe", since: "2026-01-01" },
  );
  assert.deepEqual(
    qs.map((x) => [x.text, x.origin, x.weight]),
    [
      ["What did Jane Doe decide about the Acme migration?", "primary", 1.25],
      ["Jane's Acme migration decision", "agent", 1],
      ["jane doe decide acme migration", "cli", 0.6],
      ["Jane Doe Acme", "cli", 0.6],
      ["jane-doe since 2026-01-01 jane doe decide acme migration", "cli", 0.6],
    ],
  );
});

test("dedupe is case-insensitive after whitespace normalisation", () => {
  const qs = buildRecallQueries(["  decision   migration ", "Decision Migration"]);
  assert.deepEqual(
    qs.map((x) => [x.text, x.origin]),
    [["decision migration", "primary"]],
  );
});

test("noExpand keeps only primary and agent phrasings; blank agent phrasings are dropped", () => {
  const qs = buildRecallQueries(["Acme incident", "", "  ", "acme outage"], {}, true);
  assert.deepEqual(
    qs.map((x) => [x.text, x.origin]),
    [
      ["Acme incident", "primary"],
      ["acme outage", "agent"],
    ],
  );
});

test("keyword phrase drops stopwords and single-char tokens; entity phrase keeps capitalized runs", () => {
  const qs = buildRecallQueries(["Is the A/B test for Acme Studio on?"]);
  const cli = qs.filter((x) => x.origin === "cli").map((x) => x.text);
  // "Is" is a stopword; single letters survive the entity regex (documented quirk).
  assert.deepEqual(cli, ["test acme studio", "A B Acme Studio"]);
});

test("resolved people are appended to the entity phrasing as slugs and names, deduped, even when no capitalized run exists", () => {
  const qs = buildRecallQueries(["what did zhenya decide about the rollout"], {}, false, ["evgenia-ivanova"]);
  const cli = qs.filter((x) => x.origin === "cli").map((x) => x.text);
  assert.deepEqual(cli, [
    "zhenya decide rollout",
    "evgenia-ivanova evgenia ivanova",
    "zhenya decide rollout evgenia-ivanova evgenia ivanova",
  ]);
  const withCaps = buildRecallQueries(["What did Zhenya decide"], {}, false, ["evgenia-ivanova"]);
  assert.equal(withCaps.find((x) => x.text.startsWith("Zhenya evgenia-ivanova"))?.origin, "cli");
  assert.deepEqual(buildRecallQueries(["q"], {}, true, ["evgenia-ivanova"]).map((x) => x.text), ["q"]);
});
