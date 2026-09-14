/**
 * Sentence embeddings, computed locally — no API key, and no network call at query time, so anyone who clones the
 * repo can reproduce the retrieval numbers with `npm run embed && npm run eval:retrieval`.
 *
 * Two things this file has to get right for the hosted deployment:
 *
 *  1. **No download at request time.** `npm run model:fetch` copies the model into `models/` and this loader points
 *     @huggingface/transformers at that directory with remote fetching switched off. A serverless function that
 *     downloaded 23-90 MB from huggingface.co on a cold start would be at the mercy of a third party on the request
 *     path; bundling the file makes the cold start a local read instead. Falls back to the hub (dev machines that
 *     have not run the fetch script yet) unless EMBEDDING_LOCAL_ONLY=1.
 *  2. **The query must be embedded by the same model that built the index.** A q8 query vector scored against an
 *     fp32 index silently loses accuracy — nothing errors, the answers just get worse. `src/lib/index-meta.ts`
 *     stamps the index with the model that built it so the mismatch is reported instead of absorbed. And whether the
 *     model loaded at all is reported per search by `searchArticlesHybridReported`, because only the process that
 *     runs retrieval can answer that — the page rendering a notice about it is a different serverless function.
 *
 * The model is loaded lazily and at most once. If it cannot be loaded (offline, or DENSE_RETRIEVAL=off), every
 * caller gets null and the search layer falls back to lexical retrieval rather than failing — the same contract
 * the Python citation service has.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMS = 384;

/**
 * Weight precision of the ONNX graph. Default `q8`: the int8 quantisation is 23 MB against fp32's 90 MB, loads in
 * roughly half the time and holds ~110 MB less resident memory, which is what makes the dense path affordable inside
 * a serverless function at all. It is **not** chosen for accuracy: on the held-out test split hybrid primary@5 reads
 * 91.3% at q8 against 88.8% at fp32, but the dev split moves the other way (95.0% against 96.2%), and both swings are
 * one to two questions out of 80. VERIFICATION.md records the full side-by-side. `EMBEDDING_DTYPE=fp32` restores the
 * original weights; the index must then be rebuilt with `npm run embed`.
 */
export type EmbeddingDtype = "fp32" | "q8";
export const EMBEDDING_DTYPE: EmbeddingDtype = process.env.EMBEDDING_DTYPE === "fp32" ? "fp32" : "q8";

/** Where `npm run model:fetch` puts the model files. Relative to the project root, so it is inside the deployment. */
export const MODEL_DIR = resolve(process.cwd(), "models");

/** Roughly the model's 256-token window; longer articles are truncated, which the README records as a limitation. */
const MAX_CHARS = 2000;

let pipelinePromise: Promise<FeatureExtractionPipeline | null> | null = null;
let loadError: string | null = null;

function disabled() {
  return process.env.DENSE_RETRIEVAL === "off";
}

/** True when the model files are present in `models/` and the hub is not needed. */
export function modelIsBundled() {
  return existsSync(resolve(MODEL_DIR, EMBEDDING_MODEL, "config.json"));
}

async function getPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (disabled()) return null;
  pipelinePromise ??= (async () => {
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      const bundled = modelIsBundled();
      if (bundled) {
        // Load from the deployment itself. `localModelPath` is where transformers.js looks before the hub.
        env.localModelPath = MODEL_DIR;
        env.allowRemoteModels = false;
      } else if (process.env.EMBEDDING_LOCAL_ONLY === "1") {
        throw new Error(`no model in ${MODEL_DIR} and EMBEDDING_LOCAL_ONLY=1 — run: npm run model:fetch`);
      }
      return await pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: EMBEDDING_DTYPE });
    } catch (error) {
      loadError = (error as Error).message;
      console.warn(`[embeddings] model unavailable, dense retrieval disabled: ${loadError}`);
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

/**
 * Why the dense path is not running, when it is not. Empty string when it is, or when it was never asked for.
 *
 * Carried out to the caller and into the search tool's own output because the alternative is guessing: a model
 * that fails to load inside a serverless function fails there and nowhere else, and "unavailable" on its own does
 * not say whether the file is missing, the native binding would not load, or someone switched it off.
 */
export function denseUnavailableReason(): string {
  if (disabled()) return "DENSE_RETRIEVAL=off";
  return loadError ?? "";
}

/** Where the loader is looking, for the same diagnostic purpose — `process.cwd()` is not the same everywhere. */
export function modelLocation() {
  return { dir: MODEL_DIR, bundled: modelIsBundled(), dtype: EMBEDDING_DTYPE, localOnly: process.env.EMBEDDING_LOCAL_ONLY === "1" };
}
