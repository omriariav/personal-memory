import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeReranker, LocalReranker, RERANK_BATCH, getReranker, resetRerankerForTest } from "./rerank.js";

test("FakeReranker: token overlap between question and document, in [0, 1]", async () => {
  const r = new FakeReranker();
  const [a, b, c] = await r.score("vendor alpha renewal", ["renew with vendor Alpha", "unrelated hiring loop", ""]);
  assert.ok(a! > b!, `${a} > ${b}`);
  assert.equal(c, 0);
  assert.ok(a! <= 1);
});

test("LocalReranker: scores (question, document) pairs in bounded batches through an injected model and applies the sigmoid", async () => {
  const batches: number[] = [];
  let n = 0;
  const load = async () => ({
    tokenizer: (qs: string[], opts: { text_pair: string[] }) => {
      assert.equal(qs.length, opts.text_pair.length);
      batches.push(qs.length);
      return { n: qs.length };
    },
    model: async (inputs: { n: number }) => ({ logits: { data: Float32Array.from({ length: inputs.n }, () => (n++ % 2 ? 2 : -2)) } }),
  });
  const r = new LocalReranker("test-model", load as any);
  const docs = Array.from({ length: RERANK_BATCH + 3 }, (_, i) => `doc ${i}`);
  const scores = await r.score("q", docs);
  assert.deepEqual(batches, [RERANK_BATCH, 3]);
  assert.equal(scores.length, docs.length);
  assert.ok(Math.abs(scores[0]! - 1 / (1 + Math.exp(2))) < 1e-9, `sigmoid(-2): ${scores[0]}`);
  assert.ok(Math.abs(scores[1]! - 1 / (1 + Math.exp(-2))) < 1e-9, `sigmoid(2): ${scores[1]}`);
  assert.deepEqual(await r.score("q", []), []);
  assert.equal(r.id, "local:test-model");
});

test("getReranker: MEMORY_RERANK_MODEL=fake selects the fake; the model is never loaded until score() is called", () => {
  resetRerankerForTest();
  const fake = getReranker({ MEMORY_RERANK_MODEL: "fake" });
  assert.equal(fake.id, "fake:token-overlap");
  resetRerankerForTest();
  const local = getReranker({});
  assert.match(local.id, /^local:/);
  resetRerankerForTest();
});
