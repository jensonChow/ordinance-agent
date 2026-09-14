import Link from "next/link";
import { indexStatus } from "@/lib/index-meta";
import { prisma } from "@/lib/prisma";
import results from "../../../eval/retrieval-results.json";

export const dynamic = "force-dynamic";

type Metrics = Record<string, number>;
type Split = "dev" | "test" | "all";

const COLUMNS = ["primary@1", "primary@3", "primary@5", "any@1", "any@3", "any@5"];
const FUSED = "hybrid RRF (bank ×2 + FTS + dense)";
const LEXICAL = "question bank → smart FTS"; // what retrieval falls back to when the dense path is off
const DENSE = "dense (articles)";

/**
 * Every figure in the prose below is read out of the evaluation's own JSON rather than typed in. An evaluation page
 * whose commentary has drifted from its own table is worse than no commentary — and the numbers do move: they
 * changed when the deployment switched to the quantised model.
 */
const score = (strategy: string, split: Split, metric = "primary@5") =>
  (results.results as Record<string, Record<Split, Metrics>>)[strategy]?.[split]?.[metric];

const mono = { font: "400 10.5px/1.4 'Geist Mono', ui-monospace, monospace", letterSpacing: ".06em" } as const;
const sans = (size: number, weight = 400, lh = 1.75) =>
  ({ font: `${weight} ${size}px/${lh} 'Noto Sans SC', sans-serif` }) as const;
const serif = (size: number) => ({ font: `600 ${size}px/1.3 'Noto Serif SC', serif` }) as const;

const pct = (v: number | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

function Table({ split }: { split: Split }) {
  const rows = Object.entries(results.results as Record<string, Record<Split, Metrics>>);
  const best = Object.fromEntries(COLUMNS.map((c) => [c, Math.max(...rows.map(([, r]) => r[split]?.[c] ?? 0))]));
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", ...mono }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--rule2)", textAlign: "left" }}>
            <th style={{ padding: "6px 12px 6px 0", fontWeight: 500 }}>
              strategy ({split}, n={results.cases / 2})
            </th>
            {COLUMNS.map((c) => (
              <th key={c} style={{ padding: "6px 8px", textAlign: "right", fontWeight: 500 }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, bySplit]) => (
            <tr key={name} style={{ borderBottom: "1px solid var(--rule)", fontWeight: name === FUSED ? 500 : 400 }}>
              <td style={{ padding: "6px 12px 6px 0", color: name === FUSED ? "var(--ink)" : "var(--ink2)" }}>{name}</td>
              {COLUMNS.map((c) => {
                const v = bySplit[split]?.[c];
                return (
                  <td
                    key={c}
                    style={{ padding: "6px 8px", textAlign: "right", color: v != null && v === best[c] ? "var(--ok)" : "var(--ink2)" }}
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
  // The whole point of an evaluation page is that the numbers describe what is running. This page cannot observe the
  // retrieval process directly (it is a different function), so it reports the configuration and the index stamp, and
  // each search reports its own live paths where the reader can see them.
  const index = await indexStatus();
  const denseOff = process.env.DENSE_RETRIEVAL === "off";

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

  const misses =
    (results.misses as Record<string, { id: string; split: string; query: string; primary: number; got: number[] }[]>)[FUSED] ?? [];
  const testMisses = misses.filter((m) => m.split === "test");

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "26px 26px 60px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
        <Link href="/" style={{ ...serif(19), letterSpacing: ".05em" }}>
          基本法研讀
        </Link>
        <h1 style={{ ...serif(19), margin: 0, color: "var(--ink2)" }}>檢索到底準不準？</h1>
        <Link href="/" style={{ ...mono, color: "var(--ink4)", marginLeft: "auto" }}>
          ← 回到問答
        </Link>
      </div>

      <p style={{ ...sans(12.5), color: "var(--ink2)", marginTop: 14, borderTop: "3px double var(--rule2)", paddingTop: 14 }}>
        回答的好壞，先取決於交到模型手上的是不是對的條文。80 道學習題各有兩個改寫：改寫一是 <strong>dev</strong>，用來調停用詞與標籤；改寫二是{" "}
        <strong>test</strong>，調參期間從未看過。題目本身從不作為查詢。<em>primary@k</em> = 題庫列的第一條在前 k 個結果裡；
        <em>any@k</em> = 列出的任一條在裡面。
      </p>

      {denseOff ? (
        <p
          style={{
            ...sans(11.5),
            color: "var(--seal)",
            background: "var(--sealbg)",
            borderLeft: "3px solid var(--seal)",
            padding: "10px 13px",
            margin: "16px 0",
          }}
        >
          <strong>這個部署沒有跑向量檢索。</strong> 這裡設了 <code style={mono}>DENSE_RETRIEVAL=off</code>，檢索退回「題庫 + 全文檢索」——也就是下表的{" "}
          <em>question bank → smart FTS</em> 那一行，test 集 primary@5 為 <strong>{pct(score(LEXICAL, "test"))}</strong>，不是{" "}
          {pct(score(FUSED, "test"))}。表中數字是開著向量路測的；把倉庫克隆下來跑{" "}
          <code style={mono}>npm run embed &amp;&amp; npm run eval:retrieval</code> 即可復現，不需要任何 key。
        </p>
      ) : null}

      {index.state === "ok" ? (
        <p style={{ ...mono, color: "var(--ink4)", margin: "12px 0 0" }}>
          向量索引 <span lang="en">{index.built}</span>
          {index.builtAt ? ` · 建於 ${index.builtAt.toISOString().slice(0, 10)}` : ""} —— 與本進程載入的模型相符
        </p>
      ) : index.state === "off" ? null : (
        <p
          style={{
            ...sans(11.5),
            color: "var(--seal)",
            background: "var(--sealbg)",
            borderLeft: "3px solid var(--seal)",
            padding: "10px 13px",
            margin: "16px 0",
          }}
        >
          <strong>{index.state === "missing" ? "資料庫裡沒有向量索引。" : "向量索引與本進程的模型不符。"}</strong>{" "}
          {index.state === "missing" ? (
            <>
              向量那兩條路會回傳空集，檢索退回「題庫 + 全文檢索」。跑 <code style={mono}>npm run embed</code> 建索引。
            </>
          ) : (
            <>
              索引由 <span lang="en">{index.built}</span> 建，本進程載入的是 <span lang="en">{index.running}</span>。
              兩者的向量不在同一個空間裡，點積仍然算得出數字、仍然回五條條文，只是更差的五條——所以這裡寧可說出來。重跑{" "}
              <code style={mono}>npm run embed</code> 即可對齊。
            </>
          )}
        </p>
      )}

      <section style={{ marginTop: 22 }}>
        <h2 style={{ ...serif(14), margin: "0 0 8px" }}>test 集 —— 對外只引這一組</h2>
        <Table split="test" />
        <p style={{ ...sans(11), color: "var(--ink4)", marginTop: 8 }}>
          兩點值得留意。純向量檢索（{pct(score(DENSE, "test"))} primary@5）勝過整套手寫題庫加調過參的詞法管線（
          {pct(score(LEXICAL, "test"))}）—— 一個 23 MB、從沒見過這套語料的模型，贏過那些調參。而四條路融合起來（
          {pct(score(FUSED, "test"))}），又比其中任何一條都好。
        </p>
      </section>

      <section style={{ marginTop: 26 }}>
        <h2 style={{ ...serif(14), margin: "0 0 8px" }}>dev 集 —— 調參用的，照實列出</h2>
        <Table split="dev" />
        <p style={{ ...sans(11), color: "var(--ink4)", marginTop: 8 }}>
          dev 與 test 的差距就是過擬合的大小。融合策略在 primary@5 上差{" "}
          {(100 * ((score(FUSED, "dev") ?? 0) - (score(FUSED, "test") ?? 0))).toFixed(1)} 分；此前那套在 dev 上調出來的詞法管線差{" "}
          {(100 * ((score(LEXICAL, "dev") ?? 0) - (score(LEXICAL, "test") ?? 0))).toFixed(1)} 分。
        </p>
      </section>

      <section style={{ marginTop: 26 }}>
        <h2 style={{ ...serif(14), margin: "0 0 8px" }}>仍然找錯的（test 集 80 題中的 {testMisses.length} 題）</h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
          {testMisses.slice(0, 10).map((m) => (
            <li key={m.id} style={{ ...mono, background: "var(--sheet)", border: "1px solid var(--rule)", padding: "6px 9px", color: "var(--ink2)" }}>
              <span style={{ color: "var(--ink4)" }}>{m.id}</span> <span lang="en">“{m.query}”</span> — 應為{" "}
              <Link href={`/article/${m.primary}`} style={{ textDecoration: "underline" }}>
                art. {m.primary}
              </Link>
              ，實得 <span style={{ color: "var(--ink4)" }}>{m.got.join(", ")}</span>
            </li>
          ))}
        </ul>
        {testMisses.length > 10 ? (
          <p style={{ ...sans(11), color: "var(--ink4)", marginTop: 6 }}>…還有 {testMisses.length - 10} 題，全部列在 eval/RESULTS.md。</p>
        ) : null}
      </section>

      <section style={{ marginTop: 26, borderTop: "3px double var(--rule2)", paddingTop: 16 }}>
        <h2 style={{ ...serif(14), margin: "0 0 8px" }}>讀者在本站給出的判斷</h2>
        {ratingCount === 0 ? (
          <p style={{ ...sans(11.5), color: "var(--ink3)" }}>
            還沒有評分。在回答裡點開一條引用，給它 0–5 分；分數會寫進 PostgreSQL 並匯總到這裡。
            上面的基準問的是「檢索有沒有找到題庫認定的條文」，這裡問的是「讀者覺得有沒有用」—— 後者沒有任何自動指標答得了。
          </p>
        ) : (
          <div style={{ ...sans(11.5), display: "grid", gap: 10 }}>
            <p style={{ margin: 0 }}>
              共 <strong>{ratingCount}</strong> 條判斷，平均 <strong>{(ratingAvg._avg.value ?? 0).toFixed(2)}</strong> / 5。
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {byValue.map((b) => (
                <span key={b.value} style={{ ...mono, background: "var(--sheet)", border: "1px solid var(--rule)", padding: "3px 8px" }}>
                  {b.value} × {b._count._all}
                </span>
              ))}
            </div>
            <div>
              <p style={{ ...mono, color: "var(--ink4)", margin: "0 0 4px" }}>被評最多的條文</p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2 }}>
                {topRated.map((r) => (
                  <li key={r.articleNumber}>
                    <Link href={`/article/${r.articleNumber}`} style={{ ...mono, textDecoration: "underline" }}>
                      art. {r.articleNumber}
                    </Link>{" "}
                    —— {r._count._all} 條評分，平均 {(r._avg.value ?? 0).toFixed(2)}
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
