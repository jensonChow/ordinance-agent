/**
 * Sentence embeddings, computed locally — no API key and no network call at query time once the model is cached,
 * so anyone who clones the repo can reproduce the retrieval numbers with `npm run embed && npm run eval:retrieval`.
 *
 * The model is loaded lazily and at most once. If it cannot be loaded (offline, or DENSE_RETRIEVAL=off), every
 * caller gets null and the search layer falls back to lexical retrieval rather than failing — the same contract
 * the Python citation service has.
 */
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

/** Roughly the model's 256-token window; longer articles are truncated, which the README records as a limitation. */
const MAX_CHARS = 2000;

let pipelinePromise: Promise<FeatureExtractionPipeline | null> | null = null;

function disabled() {
  return process.env.DENSE_RETRIEVAL === "off";
}

async function getPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (disabled()) return null;
  pipelinePromise ??= (async () => {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      return await pipeline("feature-extraction", EMBEDDING_MODEL);
    } catch (error) {
      console.warn(`[embeddings] model unavailable, dense retrieval disabled: ${(error as Error).message}`);
      return null;
    }
  })();
  return pipelinePromise;
}

/** Embed a batch of texts as L2-normalised vectors, or null when the model is unavailable. */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const pipe = await getPipeline();
  if (!pipe) return null;
  const output = await pipe(
    texts.map((t) => t.slice(0, MAX_CHARS)),
    { pooling: "mean", normalize: true },
  );
  return output.tolist() as number[][];
}

/** Embed one text, or null when the model is unavailable. */
export async function embedOne(text: string): Promise<number[] | null> {
  const [vector] = (await embed([text])) ?? [];
  return vector ?? null;
}

/** Dot product of two L2-normalised vectors = cosine similarity. */
export function cosine(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i] * b[i];
  return sum;
}
