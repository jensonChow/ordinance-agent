import Link from "next/link";
import { prisma } from "@/lib/prisma";
import results from "../../../eval/retrieval-results.json";

export const dynamic = "force-dynamic";

type Metrics = Record<string, number>;
type Split = "dev" | "test" | "all";

const COLUMNS = ["primary@1", "primary@3", "primary@5", "any@1", "any@3", "any@5"];
const FUSED = "hybrid RRF (bank ×2 + FTS + dense)";

const pct = (v: number | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function Table({ split }: { split: Split }) {
  const rows = Object.entries(results.results as Record<string, Record<Split, Metrics>>);
  const best = Object.fromEntries(
    COLUMNS.map((c) => [c, Math.max(...rows.map(([, r]) => r[split]?.[c] ?? 0))]),
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-neutral-300 text-left dark:border-neutral-700">
            <th className="py-1.5 pr-3 font-medium">strategy ({split}, n={results.cases / 2})</th>
            {COLUMNS.map((c) => (
              <th key={c} className="px-2 py-1.5 text-right font-mono font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, bySplit]) => (
            <tr key={name} className={`border-b border-neutral-100 dark:border-neutral-900 ${name === FUSED ? "font-medium" : ""}`}>
              <td className="py-1.5 pr-3">{name}</td>
              {COLUMNS.map((c) => {
                const v = bySplit[split]?.[c];
                return (
                  <td
                    key={c}
                    className={`px-2 py-1.5 text-right font-mono ${v != null && v === best[c] ? "text-emerald-700 dark:text-emerald-300" : ""}`}
                  >
                    {pct(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function EvalPage() {
  // Human relevance judgements collected in the app, next to the offline benchmark.
  const [ratingCount, ratingAvg, byValue, topRated] = await Promise.all([
    prisma.rating.count(),
    prisma.rating.aggregate({ _avg: { value: true } }),
    prisma.rating.groupBy({ by: ["value"], _count: { _all: true }, orderBy: { value: "asc" } }),
    prisma.rating.groupBy({
      by: ["articleNumber"],
      _count: { _all: true },
      _avg: { value: true },
      orderBy: { _count: { articleNumber: "desc" } },
      take: 8,
    }),
  ]);

  const misses = (results.misses as Record<string, { id: string; split: string; query: string; primary: number; got: number[] }[]>)[FUSED] ?? [];
  const testMisses = misses.filter((m) => m.split === "test");

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-xl font-semibold tracking-tight">How well does the retrieval work?</h1>
          <Link href="/" className="text-xs text-neutral-500 underline-offset-2 hover:underline">
            back to the agent
          </Link>
        </div>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          An answer is only as good as the articles it was given. Each of the 80 study questions carries two
          paraphrases: paraphrase 1 is the <strong>dev</strong> split and was used to tune stop-words and tags;
          paraphrase 2 is the <strong>test</strong> split and was never looked at while tuning. The canonical
          questions are never used as queries. <em>primary@k</em> = the first article the bank lists for a question is
          in the top k; <em>any@k</em> = any listed article is.
        </p>
      </header>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Test split — the number to quote</h2>
        <Table split="test" />
        <p className="mt-2 text-xs text-neutral-500">
          Two things worth noticing. Dense retrieval alone (86.3% primary@5) beats the entire hand-written question
          bank plus tuned lexical pipeline (80.0%) — a 23 MB model that has never seen this corpus outscores the
          tuning. And fusing all four paths is better than any one of them.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Dev split — tuned on, shown for honesty</h2>
        <Table split="dev" />
        <p className="mt-2 text-xs text-neutral-500">
          The gap between dev and test is the size of the overfit. For the fused strategy it is 7.5 points at
          primary@5; for the lexical pipeline that was tuned on dev it was 15.0.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">What it still gets wrong ({testMisses.length} of 80 on test)</h2>
        <ul className="space-y-1 text-xs">
          {testMisses.slice(0, 10).map((m) => (
            <li key={m.id} className="rounded bg-neutral-50 px-2 py-1.5 dark:bg-neutral-900">
              <span className="font-mono text-neutral-500">{m.id}</span> “{m.query}” — wanted{" "}
              <Link href={`/article/${m.primary}`} className="font-mono underline underline-offset-2">
                Art. {m.primary}
              </Link>
              , returned <span className="font-mono text-neutral-500">{m.got.join(", ")}</span>
            </li>
          ))}
        </ul>
        {testMisses.length > 10 ? (
          <p className="mt-1 text-xs text-neutral-500">…and {testMisses.length - 10} more, all listed in eval/RESULTS.md.</p>
        ) : null}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Reader judgements collected in this app</h2>
        {ratingCount === 0 ? (
          <p className="text-xs text-neutral-500">
            No ratings yet. Open a citation in an answer and score it 0–5; the scores land in PostgreSQL and are
            aggregated here. The benchmark above asks whether retrieval found the article the bank calls correct;
            this asks whether a reader found it useful, which no automatic metric can answer.
          </p>
        ) : (
          <div className="space-y-3 text-xs">
            <p>
              <strong>{ratingCount}</strong> judgement{ratingCount === 1 ? "" : "s"}, mean{" "}
              <strong>{(ratingAvg._avg.value ?? 0).toFixed(2)}</strong> out of 5.
            </p>
            <div className="flex flex-wrap gap-3">
              {byValue.map((b) => (
                <span key={b.value} className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-900">
                  <span className="font-mono">{b.value}</span> × {b._count._all}
                </span>
              ))}
            </div>
            <div>
              <p className="mb-1 text-neutral-500">Most-rated articles</p>
              <ul className="space-y-0.5">
                {topRated.map((r) => (
                  <li key={r.articleNumber}>
                    <Link href={`/article/${r.articleNumber}`} className="font-mono underline underline-offset-2">
                      Art. {r.articleNumber}
                    </Link>{" "}
                    — {r._count._all} rating{r._count._all === 1 ? "" : "s"}, mean {(r._avg.value ?? 0).toFixed(2)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
