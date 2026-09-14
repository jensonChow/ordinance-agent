/**
 * Put the sentence-embedding model inside the project, so nothing is downloaded on the request path.
 *
 *   npm run model:fetch                 # the dtype the app is configured for (EMBEDDING_DTYPE, default fp32)
 *   npm run model:fetch -- --dtype q8   # explicitly
 *   npm run model:fetch -- --all        # both, for comparing them in the evaluation
 *
 * Runs as `prebuild`, so a Vercel build bundles the model into the function and a cold start reads it from local
 * disk instead of fetching 23 MB from huggingface.co while a user waits. Idempotent: files already present at the
 * right size are left alone. **Never fatal** — if the download fails the build continues and the runtime falls back
 * to the hub, or, failing that, to lexical retrieval only (see src/lib/embeddings.ts).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EMBEDDING_DTYPE, EMBEDDING_MODEL, MODEL_DIR, type EmbeddingDtype } from "../src/lib/embeddings";

const HUB = "https://huggingface.co";
const SHARED = ["config.json", "tokenizer.json", "tokenizer_config.json"];
const ONNX: Record<EmbeddingDtype, string> = {
  fp32: "onnx/model.onnx",
  q8: "onnx/model_quantized.onnx",
};

const args = process.argv.slice(2);
const dtypes: EmbeddingDtype[] = args.includes("--all")
  ? ["fp32", "q8"]
  : [(args[args.indexOf("--dtype") + 1] as EmbeddingDtype) || EMBEDDING_DTYPE].filter((d) => d in ONNX);

const target = resolve(MODEL_DIR, EMBEDDING_MODEL);

function sizeOf(path: string) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

async function download(file: string) {
  const path = join(target, file);
  const url = `${HUB}/${EMBEDDING_MODEL}/resolve/main/${file}`;
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!head.ok) throw new Error(`HEAD ${url} -> ${head.status}`);
  const expected = Number(head.headers.get("content-length") ?? "0");
  if (expected > 0 && sizeOf(path) === expected) {
    console.log(`  = ${file} (${expected.toLocaleString()} bytes, already present)`);
    return;
  }
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (expected > 0 && bytes.length !== expected) throw new Error(`${file}: expected ${expected} bytes, got ${bytes.length}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  console.log(`  + ${file} (${bytes.length.toLocaleString()} bytes, sha256:${sha}…)`);
}

async function main() {
  console.log(`model: ${EMBEDDING_MODEL} -> ${target}`);
  console.log(`dtype: ${dtypes.join(", ")}`);
  for (const file of [...SHARED, ...dtypes.map((d) => ONNX[d])]) await download(file);

  // The loader keys off config.json; a half-written directory would make it fall back to the hub, not fail hard.
  const config = JSON.parse(readFileSync(join(target, "config.json"), "utf8")) as { hidden_size?: number };
  console.log(`hidden_size: ${config.hidden_size} (expect 384)`);
}

main().catch((error: Error) => {
  // A build must not fail because huggingface.co was unreachable.
  console.warn(`[model:fetch] skipped: ${error.message}`);
  console.warn("[model:fetch] the app will try the hub at runtime, and fall back to lexical retrieval if that fails");
});
