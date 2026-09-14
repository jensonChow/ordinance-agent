import type { NextConfig } from "next";

/**
 * The dense retrieval path runs inside the serverless function, so the deployment has to carry both the ONNX
 * runtime and the model — and a Vercel function is capped at 250 MB unzipped. Three rules keep it well under:
 *
 *  - **Bundle the model, name the files.** `npm run model:fetch` (wired as `prebuild`) writes `models/`, and only
 *    the q8 files are traced in. Without this the function would fetch 23 MB from huggingface.co on a cold start,
 *    putting a third party on the request path.
 *  - **Drop the runtimes this platform cannot use.** `onnxruntime-node` ships prebuilt binaries for five platforms
 *    (212 MB in total, of which Vercel uses linux/x64 at 35 MB); `onnxruntime-web` is another 130 MB of WASM that
 *    the Node backend never loads, and `sharp` is an image dependency of @huggingface/transformers that a
 *    text-embedding pipeline has no use for.
 *  - **Keep the package external.** Native `.node` bindings cannot be bundled by webpack/turbopack.
 *
 * Measured after these rules: see VERIFICATION.md for the traced size of each route.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["@huggingface/transformers"],

  outputFileTracingIncludes: {
    // Listed file by file rather than `models/**` so the 90 MB fp32 graph sitting next to the q8 one cannot be
    // dragged in by accident. Running the deployment at fp32 would therefore need this list changed too.
    "/api/mcp": [
      "models/Xenova/all-MiniLM-L6-v2/config.json",
      "models/Xenova/all-MiniLM-L6-v2/tokenizer.json",
      "models/Xenova/all-MiniLM-L6-v2/tokenizer_config.json",
      "models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx",
      // onnxruntime-node reaches its native binary through a runtime require of a platform path, which the tracer
      // does not follow: measured on this build, `bin/` contributed 0 bytes to the traced set. Ship it explicitly or
      // the function loses the dense path *silently* — src/lib/embeddings.ts reports that state rather than hiding it.
      "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/*",
    ],
  },

  outputFileTracingExcludes: {
    "*": [
      "node_modules/onnxruntime-node/bin/napi-v6/win32/**",
      "node_modules/onnxruntime-node/bin/napi-v6/darwin/**",
      "node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**",
      // The development machine's own model cache. 114 MB of weights that were traced in purely because this repo
      // had been run before the build — nothing in a deployment should depend on a developer's cache directory.
      "node_modules/@huggingface/transformers/.cache/**",
      // fp32 weights sit beside the q8 ones; only the configured dtype belongs in the function.
      "models/Xenova/all-MiniLM-L6-v2/onnx/model.onnx",
      "node_modules/onnxruntime-web/**",
      "node_modules/sharp/**",
      "node_modules/@img/**",
    ],
  },
};

export default nextConfig;
