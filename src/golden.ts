import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { MEMORY_TYPES } from "./schema.js";
import { MEMORY_DIR } from "./ingest.js";
import type { EvalCase } from "./eval.js";

/**
 * The private golden set: real queries against the real store with
 * user-confirmed expected entries. Lives INSIDE the private store
 * (`memory/eval/`) so it is versioned by the nested repo and never leaves the
 * machine — never under `docs/`. Written only through `memory eval …`.
 */

export function goldenPaths(dir: string = MEMORY_DIR) {
  const base = join(dir, "eval");
  return {
    dir: base,
    golden: join(base, "golden.json"),
    baseline: join(base, "baseline.json"),
    lastRun: join(base, "last-run.json"),
  };
}

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lower-kebab slug");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const id = z.string().min(1);

const FiltersSchema = z
  .object({
    person: slug.optional(),
    type: z.enum(MEMORY_TYPES).optional(),
    team: slug.optional(),
    tag: slug.optional(),
    since: date.optional(),
    until: date.optional(),
    graph: slug.optional(),
  })
  .strict();

export const GoldenCaseSchema = z
  .object({
    id: z.string().regex(/^g-\d{3,}$/),
    kind: z.literal("golden"),
    query: z.string().min(1),
    phrasings: z.array(z.string().min(1)).optional(),
    filters: FiltersSchema.optional(),
    expect: z.union([z.array(id), z.record(id, z.number().positive())]),
    mustNotOutrank: z.array(z.tuple([id, id])).optional(),
    expectAbsent: z.array(id).optional(),
    expectChain: z.object({ id, status: z.enum(["open", "resolved"]).optional(), latest: id.optional() }).strict().optional(),
    expectExhaustive: z.boolean().optional(),
    k: z.number().int().positive().optional(),
    passAtK: z.number().int().positive().optional(),
    noExpand: z.boolean().optional(),
    xfail: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .strict();

export const GoldenFileSchema = z.object({ version: z.literal(1), cases: z.array(GoldenCaseSchema) }).strict();

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

export async function readGolden(dir: string = MEMORY_DIR): Promise<EvalCase[]> {
  const path = goldenPaths(dir).golden;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const parsed = GoldenFileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid ${path}:\n` + parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    );
  }
  return parsed.data.cases as EvalCase[];
}

export async function writeGolden(cases: EvalCase[], dir: string = MEMORY_DIR): Promise<string> {
  const paths = goldenPaths(dir);
  const file = GoldenFileSchema.parse({ version: 1, cases });
  await mkdir(paths.dir, { recursive: true });
  const tmp = `${paths.golden}.tmp`;
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  await rename(tmp, paths.golden);
  return paths.golden;
}

export function nextGoldenId(cases: Pick<EvalCase, "id">[]): string {
  const max = cases.reduce((m, c) => {
    const n = Number(/^g-(\d+)$/.exec(c.id)?.[1] ?? 0);
    return n > m ? n : m;
  }, 0);
  return `g-${String(max + 1).padStart(3, "0")}`;
}

export type GoldenInput = Omit<EvalCase, "id" | "kind"> & { id?: string };

/** Pure: append a validated golden case (id assigned unless given). */
export function addGoldenCase(cases: EvalCase[], input: GoldenInput): EvalCase[] {
  const query = input.query.trim();
  if (!query) throw new Error("golden case needs a non-empty query");
  const expected = Array.isArray(input.expect) ? input.expect.length : Object.keys(input.expect).length;
  if (expected === 0 && !input.mustNotOutrank?.length && !input.expectAbsent?.length && !input.expectChain) {
    throw new Error("golden case has nothing to assert — pass --expect, --must-outrank, or --absent");
  }
  const c = GoldenCaseSchema.parse({ ...input, query, id: input.id ?? nextGoldenId(cases), kind: "golden" });
  if (cases.some((x) => x.id === c.id)) throw new Error(`golden case ${c.id} already exists`);
  return [...cases, c as EvalCase];
}
