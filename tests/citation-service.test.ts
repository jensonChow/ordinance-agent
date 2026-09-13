/**
 * The Python citation service is optional by design: useful when it is running, never load-bearing.
 * These tests pin that contract, since the failure mode they guard against (a hung microservice stalling
 * the agent loop) does not show up in a happy-path run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callCitationService } from "@/lib/citation-service";

const SERVICE = "http://127.0.0.1:8000";
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.CITATION_SERVICE_URL = SERVICE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CITATION_SERVICE_URL;
  vi.restoreAllMocks();
});

describe("callCitationService", () => {
  it("returns the parsed body when the service answers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ citation: "Basic Law, art. 24(2)" }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callCitationService("/cite", { article: 24, paragraph: 2 })).resolves.toEqual({
      citation: "Basic Law, art. 24(2)",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SERVICE}/cite`);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not call out at all when the service is not configured", async () => {
    delete process.env.CITATION_SERVICE_URL;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(callCitationService("/parse", { text: "Article 24" })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades to null on a non-2xx response, a network error and a timeout", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(callCitationService("/cite", {})).resolves.toBeNull();

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(callCitationService("/cite", {})).resolves.toBeNull();

    globalThis.fetch = (async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    await expect(callCitationService("/cite", {})).resolves.toBeNull();
  });

  it("tolerates a trailing slash in the configured base URL", async () => {
    process.env.CITATION_SERVICE_URL = `${SERVICE}/`;
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callCitationService("/parse", { text: "x" });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${SERVICE}/parse`);
  });
});
