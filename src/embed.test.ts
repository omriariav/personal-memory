import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBED_BATCH, LocalEmbedder } from "./embed.js";

/** Fake Transformers.js extractor: records batch sizes, returns [n, 2] rows. */
function fakeExtractor() {
  const batches: number[] = [];
  let seq = 0;
  const extractor = async (texts: string[], _opts: unknown) => {
    batches.push(texts.length);
    const rows = texts.map(() => [seq++, 0]);
    return { tolist: () => rows };
  };
  return { extractor, batches };
}

test("LocalEmbedder embeds in bounded batches and preserves input order", async () => {
  const { extractor, batches } = fakeExtractor();
  const e = new LocalEmbedder(async () => extractor);
  const n = EMBED_BATCH * 2 + 5;
  const out = await e.embed(Array.from({ length: n }, (_, i) => `t${i}`));
  assert.deepEqual(batches, [EMBED_BATCH, EMBED_BATCH, 5]);
  assert.equal(out.length, n);
  assert.deepEqual(out[0], [0, 0]);
  assert.deepEqual(out[n - 1], [n - 1, 0]);
});

test("LocalEmbedder: empty input never touches the model", async () => {
  let loaded = false;
  const e = new LocalEmbedder(async () => {
    loaded = true;
    return fakeExtractor().extractor;
  });
  assert.deepEqual(await e.embed([]), []);
  assert.equal(loaded, false);
});
