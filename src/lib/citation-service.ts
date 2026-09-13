/**
 * Client for the optional Python (Flask + Gunicorn) citation service — see services/citation-py.
 *
 * The service stands in for an existing Python application: useful when it is there, never load-bearing. Every
 * call is bounded by a timeout and returns null on any failure, so the caller falls back to the local
 * implementation instead of stalling the agent loop.
 */
const TIMEOUT_MS = 2500;

export type CitationServiceResult<T> = { data: T; source: "python-service" } | { data: null; source: "local" };

export async function callCitationService<T>(path: string, body: unknown): Promise<T | null> {
  const base = process.env.CITATION_SERVICE_URL;
  if (!base) return null;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // unreachable, timed out, or not JSON — the caller degrades to the local path
    return null;
  }
}
