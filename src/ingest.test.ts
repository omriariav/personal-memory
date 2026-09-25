import { test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry } from "./schema.js";
import { entrySearchText, headerText } from "./ingest.js";

function entry(partial: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "2026-01-01-alpha-beta",
    date: "2026-01-01",
    type: "decision",
    title: "Alpha Beta rollout",
    people: ["jane-doe"],
    teams: [],
    tags: ["rollout"],
    body: "We agreed to ship Alpha Beta next week.\n\nRisks: none.",
    path: "/x/store/2026-01-01-alpha-beta.md",
    paths: {},
    graphs: ["default"],
    ...partial,
  } as MemoryEntry;
}

test("headerText: title plus metadata, never the body", () => {
  const h = headerText(entry({}));
  assert.match(h, /^# Alpha Beta rollout\n/);
  assert.match(h, /people: jane-doe/);
  assert.match(h, /tags: rollout/);
  assert.doesNotMatch(h, /agreed to ship/);
});

test("entrySearchText: the title is repeated titleRepeat times so BM25 weights it; 1 = today's text", () => {
  const once = entrySearchText(entry({}), 1);
  const twice = entrySearchText(entry({}), 2);
  const count = (s: string) => s.split("Alpha Beta rollout").length - 1;
  assert.equal(count(once), 1);
  assert.equal(count(twice), 2);
  assert.ok(twice.includes("body:\nWe agreed"));
});
