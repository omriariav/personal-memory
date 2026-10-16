import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMBED_BATCH,
  LocalEmbedder,
  OpenAIEmbedder,
  embedBatchSize,
  embedInBatches,
  type Embedder,
} from "./embed.js";

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

/** Deterministic fake: each vector encodes its text, and every call's size is recorded. */
function fakeEmbedder(): Embedder & { calls: number[] } {
  const calls: number[] = [];
  return {
    id: "fake",
    dim: 2,
    calls,
    async embed(texts: string[]) {
      calls.push(texts.length);
      return texts.map((t) => [Number(t.slice(1)), t.length]);
    },
  };
}

const texts = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);

/** Run `fn` with MEMORY_EMBED_BATCH set, restoring the previous value afterwards. */
async function withBatchEnv(value: string, fn: () => Promise<void>) {
  const prev = process.env.MEMORY_EMBED_BATCH;
  process.env.MEMORY_EMBED_BATCH = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.MEMORY_EMBED_BATCH;
    else process.env.MEMORY_EMBED_BATCH = prev;
  }
}

test("LocalEmbedder embeds in bounded batches and preserves input order", async () => {
  const { extractor, batches } = fakeExtractor();
  const e = new LocalEmbedder(async () => extractor);
  const n = EMBED_BATCH * 2 + 5;
  const out = await e.embed(texts(n));
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

test("LocalEmbedder honours MEMORY_EMBED_BATCH", async () => {
  await withBatchEnv("3", async () => {
    const { extractor, batches } = fakeExtractor();
    await new LocalEmbedder(async () => extractor).embed(texts(7));
    assert.deepEqual(batches, [3, 3, 1]);
  });
});

test("OpenAIEmbedder sends one request per batch and concatenates in order", async () => {
  const realFetch = globalThis.fetch;
  const prevKey = process.env.OPENAI_API_KEY;
  const bodies: number[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    bodies.push(input.length);
    const data = input.map((t) => ({ embedding: [Number(t.slice(1))] }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    await withBatchEnv("4", async () => {
      const out = await new OpenAIEmbedder("m", 1).embed(texts(10));
      assert.deepEqual(bodies, [4, 4, 2]);
      assert.deepEqual(
        out.map((v) => v[0]),
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      );
    });
  } finally {
    globalThis.fetch = realFetch;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  }
});

test("embedInBatches: N texts → ceil(N/B) calls, none larger than B, order preserved", async () => {
  const fake = fakeEmbedder();
  const vectors = await embedInBatches(fake, texts(10), 4);
  assert.deepEqual(fake.calls, [4, 4, 2]);
  assert.deepEqual(
    vectors.map((v) => v[0]),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test("embedInBatches: an exact multiple of B makes no trailing empty call", async () => {
  const fake = fakeEmbedder();
  await embedInBatches(fake, texts(6), 3);
  assert.deepEqual(fake.calls, [3, 3]);
});

test("embedInBatches: B larger than N → one call", async () => {
  const fake = fakeEmbedder();
  const vectors = await embedInBatches(fake, texts(5), 64);
  assert.deepEqual(fake.calls, [5]);
  assert.equal(vectors.length, 5);
});

test("embedInBatches: empty input → zero calls", async () => {
  const fake = fakeEmbedder();
  assert.deepEqual(await embedInBatches(fake, [], 4), []);
  assert.deepEqual(fake.calls, []);
});

test("embedInBatches: batched output equals one unbatched call", async () => {
  const input = texts(23);
  const batched = await embedInBatches(fakeEmbedder(), input, 5);
  const whole = await fakeEmbedder().embed(input);
  assert.deepEqual(batched, whole);
});

test("a non-positive or fractional batch size is rejected before any call", async () => {
  for (const bad of [0, -1, 2.5, Number.NaN]) {
    const fake = fakeEmbedder();
    await assert.rejects(embedInBatches(fake, texts(3), bad), RangeError);
    assert.deepEqual(fake.calls, []);
  }
});

test("MEMORY_EMBED_BATCH: positive integers are used, anything else falls back", () => {
  assert.equal(EMBED_BATCH, 64);
  assert.equal(embedBatchSize("48"), 48);
  assert.equal(embedBatchSize(" 32 "), 32);
  for (const bad of [undefined, "", "   ", "0", "-8", "2.5", "abc", "Infinity"]) {
    assert.equal(embedBatchSize(bad), EMBED_BATCH, `input ${JSON.stringify(bad)}`);
  }
});

test("embedInBatches defaults its batch size to MEMORY_EMBED_BATCH", async () => {
  await withBatchEnv("3", async () => {
    const fake = fakeEmbedder();
    await embedInBatches(fake, texts(7));
    assert.deepEqual(fake.calls, [3, 3, 1]);
  });
});
