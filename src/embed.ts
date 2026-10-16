/**
 * Embeddings provider. Default: fully local via Transformers.js (no API key,
 * nothing leaves the machine). Optional API backends via MEMORY_EMBEDDINGS.
 */

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

const LOCAL_MODEL = process.env.MEMORY_EMBED_MODEL ?? "Xenova/bge-small-en-v1.5";
const LOCAL_DIM = 384; // bge-small-en-v1.5

/**
 * Texts per model call or API request. One padded tensor (or one HTTP body)
 * per call keeps peak memory bounded — a whole-corpus re-embed would otherwise
 * build a single [N, tokens] batch, or POST the entire store in one request.
 * Override with MEMORY_EMBED_BATCH.
 */
export const EMBED_BATCH = 64;

/** MEMORY_EMBED_BATCH when it is a positive integer, else EMBED_BATCH. */
export function embedBatchSize(raw = process.env.MEMORY_EMBED_BATCH): number {
  if (!raw?.trim()) return EMBED_BATCH;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : EMBED_BATCH;
}

/** Run `embedBatch` over consecutive slices of at most `batchSize`, preserving order. */
async function inBatches(
  texts: string[],
  batchSize: number,
  embedBatch: (slice: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError(`embed batch size must be a positive integer, got ${batchSize}`);
  }
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    for (const v of await embedBatch(texts.slice(i, i + batchSize))) vectors.push(v);
  }
  return vectors;
}

/**
 * Embed `texts` through any embedder in slices of at most `batchSize`. The
 * built-in embedders already slice internally; this is for callers holding an
 * embedder that does not.
 */
export async function embedInBatches(
  embedder: Embedder,
  texts: string[],
  batchSize = embedBatchSize(),
): Promise<number[][]> {
  return inBatches(texts, batchSize, (slice) => embedder.embed(slice));
}

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: true },
) => Promise<{ tolist(): number[][] }>;

async function loadLocalExtractor(): Promise<Extractor> {
  const { pipeline, env } = await import("@huggingface/transformers");
  // Keep model cache inside the repo (gitignored) for reproducibility.
  env.cacheDir = process.env.MEMORY_MODEL_CACHE ?? "./.cache/transformers";
  return (await pipeline("feature-extraction", LOCAL_MODEL)) as unknown as Extractor;
}

/** Local in-process embedder using Transformers.js feature-extraction. */
export class LocalEmbedder implements Embedder {
  readonly id = `local:${LOCAL_MODEL}`;
  readonly dim = LOCAL_DIM;
  private extractor: Promise<Extractor> | null = null;

  /** `load` is injectable so tests can exercise batching without a model. */
  constructor(private readonly load: () => Promise<Extractor> = loadLocalExtractor) {}

  private pipe(): Promise<Extractor> {
    if (!this.extractor) this.extractor = this.load();
    return this.extractor;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.pipe();
    // Each slice is a Tensor [n, dim]; tolist() -> number[][]
    return inBatches(texts, embedBatchSize(), async (slice) =>
      (await extractor(slice, { pooling: "mean", normalize: true })).tolist(),
    );
  }
}

/** One embeddings request against an OpenAI-shaped `/v1/embeddings` endpoint. */
async function postEmbeddings(
  url: string,
  key: string,
  model: string,
  input: string[],
  label: string,
): Promise<number[][]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) throw new Error(`${label} embeddings failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

/** OpenAI-compatible embeddings (set MEMORY_EMBEDDINGS=openai + OPENAI_API_KEY). */
export class OpenAIEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  constructor(
    private model = process.env.MEMORY_EMBED_MODEL ?? "text-embedding-3-small",
    dim = 1536,
  ) {
    this.id = `openai:${this.model}`;
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY required for MEMORY_EMBEDDINGS=openai");
    return inBatches(texts, embedBatchSize(), (slice) =>
      postEmbeddings("https://api.openai.com/v1/embeddings", key, this.model, slice, "OpenAI"),
    );
  }
}

/** Voyage AI embeddings (set MEMORY_EMBEDDINGS=voyage + VOYAGE_API_KEY). */
export class VoyageEmbedder implements Embedder {
  readonly id: string;
  readonly dim: number;
  constructor(
    private model = process.env.MEMORY_EMBED_MODEL ?? "voyage-3-lite",
    dim = 512,
  ) {
    this.id = `voyage:${this.model}`;
    this.dim = dim;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const key = process.env.VOYAGE_API_KEY;
    if (!key) throw new Error("VOYAGE_API_KEY required for MEMORY_EMBEDDINGS=voyage");
    return inBatches(texts, embedBatchSize(), (slice) =>
      postEmbeddings("https://api.voyageai.com/v1/embeddings", key, this.model, slice, "Voyage"),
    );
  }
}

/**
 * Deterministic, model-free embedder for tests and CI (MEMORY_EMBEDDINGS=fake):
 * a hashed bag of lowercase tokens, L2-normalized. Shares tokens ⇒ close
 * vectors, so retrieval behaves sensibly without any download.
 */
export class FakeEmbedder implements Embedder {
  readonly id = "fake:hashed-bag";
  readonly dim = 64;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dim).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
        v[(h >>> 0) % this.dim]! += 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

let cached: Embedder | null = null;

/** Resolve the configured embedder (default: local, fully private). */
export function getEmbedder(): Embedder {
  if (cached) return cached;
  const backend = (process.env.MEMORY_EMBEDDINGS ?? "local").toLowerCase();
  switch (backend) {
    case "openai":
      cached = new OpenAIEmbedder();
      break;
    case "voyage":
      cached = new VoyageEmbedder();
      break;
    case "local":
      cached = new LocalEmbedder();
      break;
    case "fake":
      cached = new FakeEmbedder();
      break;
    default:
      throw new Error(`Unknown MEMORY_EMBEDDINGS=${backend} (use local|openai|voyage|fake)`);
  }
  return cached;
}
