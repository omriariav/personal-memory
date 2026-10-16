/**
 * Opt-in local cross-encoder reranker (nothing leaves the machine). Scores
 * (question, document) pairs; the pure pipeline blends the scores over the
 * top-N fused candidates. Mirrors embed.ts: lazy singleton, repo-local model
 * cache, injectable loader for tests, and a model-free fake for CI.
 */

export interface Reranker {
  readonly id: string;
  /** One score per document, higher = more relevant to `query`. */
  score(query: string, docs: string[]): Promise<number[]>;
}

export const DEFAULT_RERANK_MODEL = "mixedbread-ai/mxbai-rerank-xsmall-v1";
/** Pairs per model call — bounds memory the same way EMBED_BATCH does. */
export const RERANK_BATCH = 16;

type CrossEncoder = {
  tokenizer: (queries: string[], opts: { text_pair: string[]; padding: boolean; truncation: boolean }) => unknown;
  model: (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number> } }>;
};

async function loadLocalCrossEncoder(model: string): Promise<CrossEncoder> {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
  env.cacheDir = process.env.MEMORY_MODEL_CACHE ?? "./.cache/transformers";
  const tokenizer = await AutoTokenizer.from_pretrained(model);
  const m = await AutoModelForSequenceClassification.from_pretrained(model, { dtype: "q8" } as never);
  return {
    tokenizer: (qs, opts) => tokenizer(qs, opts as never),
    model: (inputs) => m(inputs as never) as never,
  };
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export class LocalReranker implements Reranker {
  readonly id: string;
  private engine: Promise<CrossEncoder> | null = null;

  constructor(
    private readonly model: string = process.env.MEMORY_RERANK_MODEL ?? DEFAULT_RERANK_MODEL,
    private readonly load: (model: string) => Promise<CrossEncoder> = loadLocalCrossEncoder,
  ) {
    this.id = `local:${model}`;
  }

  private pipe(): Promise<CrossEncoder> {
    if (!this.engine) this.engine = this.load(this.model);
    return this.engine;
  }

  async score(query: string, docs: string[]): Promise<number[]> {
    if (docs.length === 0) return [];
    const { tokenizer, model } = await this.pipe();
    const out: number[] = [];
    for (let i = 0; i < docs.length; i += RERANK_BATCH) {
      const batch = docs.slice(i, i + RERANK_BATCH);
      const inputs = tokenizer(
        batch.map(() => query),
        { text_pair: batch, padding: true, truncation: true },
      );
      const { logits } = await model(inputs);
      // Single-logit heads ([n, 1]) are the norm for rerankers; a 2-class head
      // would need logits[:, 1] — not used by the supported models.
      for (let j = 0; j < batch.length; j++) out.push(sigmoid(Number(logits.data[j])));
    }
    return out;
  }
}

/** Model-free reranker for tests: token overlap of the question with the document. */
export class FakeReranker implements Reranker {
  readonly id = "fake:token-overlap";
  async score(query: string, docs: string[]): Promise<number[]> {
    const qt = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    return docs.map((d) => {
      const dt = d.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      if (dt.length === 0 || qt.size === 0) return 0;
      const hits = dt.filter((t) => qt.has(t)).length;
      return Math.min(1, hits / qt.size);
    });
  }
}

let cached: Reranker | null = null;

export function getReranker(env: Record<string, string | undefined> = process.env): Reranker {
  if (cached) return cached;
  const model = env.MEMORY_RERANK_MODEL ?? DEFAULT_RERANK_MODEL;
  cached = model === "fake" ? new FakeReranker() : new LocalReranker(model);
  return cached;
}

export function resetRerankerForTest(): void {
  cached = null;
}
