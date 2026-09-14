# design/

`Redesign.dc.html` is the source of the interface this app now has — a Claude Design canvas artboard, exported from
the project *Ordinance Agent UI 改进*. It is kept here as provenance, not as code: nothing imports it and nothing
builds it.

It is worth reading before changing the UI, because the rules that matter are stated in its component script rather
than being visible in a screenshot:

- **Five modes** — `ask` 問答, `read` 讀條文, `quiz` 自測, `notes` 筆記, `eval` 評測. Switching mode clears any manual
  rail override, so each mode reopens the rail it needs.
- **One rail at a time.** 230 + 420 + 340 does not fit at 924px, so opening one rail closes the other. The reading
  modes default to the corpus tree, the answering modes to the side panel.
- **The side panel renames itself per mode** — 證據 / 對照 / 掌握度 / 標籤 / 部署 — so it always names what it reveals.
- **The sticky header's height is measured, not assumed.** It re-wraps by width and grows when the notice opens
  (126px closed, 253px open), so a `ResizeObserver` writes `--hdr` and everything under it positions against that.

Two deliberate departures in the implementation:

1. **The retrieval trace is real.** In the canvas it is a five-step timer. Here `traceStages()` in `src/app/shell.tsx`
   derives each step from the tool calls the agent actually made this turn, and lights the qb / fts / vec lanes from
   the `found_by` the search tool returns. A fake progress bar over a real pipeline would have been the one dishonest
   thing in an app about auditability.
2. **Article text stays English.** The canvas mocks Chinese article text; the corpus is the Government's English
   booklet, and the retrieval evaluation is English-only. The interface is Chinese, article text is marked `lang="en"`,
   and the notice bar says so. Adding the authentic Chinese text would mean a multilingual embedding model and a
   re-run of every number in `eval/RESULTS.md`.

`support.js` is referenced by the artboard but is not included here: its first line reads
`// GENERATED from dc-runtime/src/*.ts — do not edit`. It is the canvas host's own runtime (pan/zoom, artboard chrome,
prop panel), not part of the design.
