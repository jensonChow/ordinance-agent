import { createAzure } from "@ai-sdk/azure";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type ProviderInfo = { provider: "azure" | "openai-compatible" | "mock"; model: string };

function pick(): ProviderInfo["provider"] {
  const forced = process.env.MODEL_PROVIDER;
  if (forced === "azure" || forced === "openai-compatible" || forced === "mock") return forced;
  return process.env.AZURE_RESOURCE_NAME && process.env.AZURE_API_KEY && process.env.AZURE_DEPLOYMENT
    ? "azure"
    : "openai-compatible";
}

/**
 * Model factory. Azure OpenAI is the primary path (as in the target deployment); any OpenAI-compatible
 * endpoint (OpenRouter, vLLM, Ollama …) is the local-development fallback; `mock` is a scripted model for
 * keyless end-to-end tests. All three go through the Vercel AI SDK provider interface, so the rest of the
 * app never sees the difference.
 */
export async function getModel(): Promise<{ model: LanguageModel; info: ProviderInfo }> {
  const provider = pick();
  if (provider === "mock") {
    const { createMockModel } = await import("./mock-model");
    return { model: createMockModel(), info: { provider, model: "scripted-basic-law-agent" } };
  }
  if (provider === "azure") {
    const resourceName = process.env.AZURE_RESOURCE_NAME;
    const apiKey = process.env.AZURE_API_KEY;
    const deployment = process.env.AZURE_DEPLOYMENT;
    if (!resourceName || !apiKey || !deployment) {
      throw new Error("Azure provider selected but AZURE_RESOURCE_NAME / AZURE_API_KEY / AZURE_DEPLOYMENT are not all set");
    }
    const azure = createAzure({ resourceName, apiKey });
    return { model: azure(deployment), info: { provider, model: deployment } };
  }
  const baseURL = process.env.OPENAI_COMPATIBLE_BASE_URL;
  const apiKey = process.env.OPENAI_COMPATIBLE_API_KEY;
  const modelId = process.env.OPENAI_COMPATIBLE_MODEL;
  if (!baseURL || !apiKey || !modelId) {
    throw new Error(
      "No model provider configured. Set AZURE_* for Azure OpenAI, OPENAI_COMPATIBLE_* for a fallback endpoint, or MODEL_PROVIDER=mock (see .env.example)",
    );
  }
  const compat = createOpenAICompatible({ name: "openai-compatible", baseURL, apiKey });
  return { model: compat(modelId), info: { provider, model: modelId } };
}
