/**
 * Provenance for the vector index: which model, at which precision, built the embeddings now in the database.
 *
 * Why this exists. A query embedded by one model and scored against an index built by another still returns five
 * articles — plausible ones, just worse ones. Nothing throws, no log line appears, and the only symptom is that
 * retrieval quietly gets worse, which is the failure this project is least willing to ship silently.
 *
 * A cheaper check was tried first and rejected: re-embed a row whose vector is already stored and compare. It does
 * not separate the cases. Because `npm run embed` embeds in batches of 32, padding to the longest text in each batch
 * perturbs the result, so a vector re-made by the *same* model reproduces to only ~0.9989 — while a *different*
 * precision of the same checkpoint lands at ~0.9967. Two thousandths apart is not a threshold anyone should rely on.
 * The numbers are in VERIFICATION.md. Storing the answer is exact and costs one row.
 */
import { EMBEDDING_DIMS, EMBEDDING_DTYPE, EMBEDDING_MODEL, modelLocation } from "@/lib/embeddings";
import { prisma } from "@/lib/prisma";

const KEY = "embedding-index";
const OBSERVED = "dense-path-observed";

/** What the running process would produce, e.g. `Xenova/all-MiniLM-L6-v2@q8`. */
export function runningStamp() {
  return `${EMBEDDING_MODEL}@${EMBEDDING_DTYPE}`;
}

/** Called by `npm run embed` once the vectors are written. */
export async function writeIndexStamp(detail: Record<string, number>) {
  const value = `${runningStamp()} dims=${EMBEDDING_DIMS} ${Object.entries(detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`;
  await prisma.indexMeta.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
  return value;
}

/**
 * Record what the retrieval process just saw, so the rest of the deployment can report it.
 *
 * The pages and the retrieval route are different serverless functions: the page can read `DENSE_RETRIEVAL` and see
 * "on" while the function that actually embeds queries has failed to load the model. That gap is not hypothetical —
 * it is exactly what the first deployment of this did, and the page went on saying vectors were enabled. So the
 * process that knows writes it down, and the pages report an observation with a timestamp instead of a setting.
 *
 * Fire-and-forget: a failed bookkeeping write must not fail a search.
 */
export function recordDenseObservation(ran: boolean, reason: string) {
  const where = modelLocation();
  const value = ran
    ? `ran · ${EMBEDDING_MODEL}@${EMBEDDING_DTYPE}${where.bundled ? " · bundled" : " · from the hub"}`
    : `not running · ${reason || "reason unknown"} · dir=${where.dir} bundled=${where.bundled} localOnly=${where.localOnly}`;
  void prisma.indexMeta
    .upsert({ where: { key: OBSERVED }, create: { key: OBSERVED, value }, update: { value } })
    .catch(() => {});
}

export type IndexStatus = {
  /** `off` — dense retrieval disabled, so nothing to match; `missing` — never embedded; `mismatch` — wrong model. */
  state: "ok" | "mismatch" | "missing" | "off";
  running: string;
  built: string | null;
  builtAt: Date | null;
  /** What the retrieval process last reported about itself, and when. Null until a search has run. */
  observed: { ran: boolean; value: string; at: Date } | null;
};

export async function indexStatus(): Promise<IndexStatus> {
  const running = runningStamp();
  const rows = await prisma.indexMeta.findMany({ where: { key: { in: [KEY, OBSERVED] } } });
  const seen = rows.find((r) => r.key === OBSERVED);
  const observed = seen ? { ran: seen.value.startsWith("ran"), value: seen.value, at: seen.updatedAt } : null;

  if (process.env.DENSE_RETRIEVAL === "off") return { state: "off", running, built: null, builtAt: null, observed };
  const row = rows.find((r) => r.key === KEY);
  if (!row) return { state: "missing", running, built: null, builtAt: null, observed };
  const built = row.value;
  // The stamp carries counts after the model name; only the model@dtype prefix decides compatibility.
  const same = built.split(" ")[0] === running;
  return { state: same ? "ok" : "mismatch", running, built, builtAt: row.updatedAt, observed };
}
