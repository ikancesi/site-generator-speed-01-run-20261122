# site-generator-speed-01-run-20261122 — native entry v6

A native (C) drop-in for makefun-site 1.0.0, byte-identical output, built for the
make.fun bounty "Build a static site faster, 22 November 2026" ($100 in USDC).

This is v6, a sixth optimization round on top of v5 (`../native-v5/`, ~55 ms
binary alone on this VM). v6 adds one structural change: a **constant-template
memo** — see below. It is the fastest correct entry built so far, but the
under-30 ms step (and the under-7 ms proxy for under-10 ms on the server) was
NOT reached; see "Honest status".

The engine runs **in-process as an N-API addon** (`sitegen.node`) loaded by
`main.ts`, with the standalone static binary (`sitegen`) as the fallback if the
addon cannot load. Same driver pattern and exec-bit fallback as v4/v5.

## Measured times (this VM, pinned to 1 CPU with `taskset -c 0`)

Binary alone, median of 7 fresh runs (interleaved A/B vs v5, child CPU user+sys):

| entry | binary alone | graded net via `node main.ts` |
|---|---|---|
| **v6** | **~49 ms** | **~65 ms** |
| v5 | ~55 ms | ~72 ms |
| v4 | ~58 ms | ~79 ms |
| v3 | ~65 ms | ~82 ms (spawn) |
| JS entry (`../entry/`) | — | ~1,400 ms (live board cpu_us 1,400,000) |
| house baseline | — | ~1,240 ms |

"Graded net" = raw `node main.ts` CPU minus the do-nothing `.ts` null entry
(~149 ms), the same subtraction the harness applies. v6 is ~6 ms faster than
v5 on the binary and ~8 ms faster on the graded number — about an 11%
improvement. It is ~25x the house baseline end-to-end on this machine.

## What v6 changed (the constant-template memo)

Measured first: the practice set executes **388,500 template ops**, and the
biggest sink was not the layouts but the small included templates that loop
over all ~30 tags (`strip-3`, `promo-2`, `badge-*`) and are included in *every*
page render (via `footer`/`header`) — re-rendering the identical tag list
hundreds of times. In case g-0002 alone, `strip-3` executed 147,628 ops and
`promo-2` 63,460 ops, both looping over `tags` (30 items) once per page.

The fix generalizes the v2 card memo: any template whose free variables
(transitively, through its includes) are only `site`/`tags`/`recent` — which
are fixed for the whole case — is rendered **once per case** into a cached
string (raw + JSON-escaped forms) and every include just copies it
(`tpl_const_memo_check` / `tpl_const_memo_build` in `src/tpl.c`, wired into
`src/build.c` after the site/tags/recent arrays are built). Fail-safe: if any
`for` loop in any template binds `site`/`tags`/`recent`, the memo is disabled
for the case (the generator's loop vars are `p`/`t`/`h`/`loop`, so this never
triggers in practice). The depth guard (`depth < 8`) is respected, matching
the reference.

Effect: template ops **388,500 → 111,588 (−71%)**. Every constant template
now renders once per case (entries = 1) instead of hundreds of times.

## Per-change effect table (binary alone, median of 7, interleaved)

| change | effect |
|---|---|
| v5 baseline | ~55 ms |
| constant-template memo (`tpl.c`, `build.c`) | ~55 → ~49 ms (−6 ms) |

## What was measured and deliberately NOT adopted

- **Op fusion (task idea 2).** Measured, not built: the remaining 111,588
  ops contain 74,713 fusible TEXT/VAR/RAW ops delimited by 36,875 control
  ops, so fusion could remove at most ~37,838 dispatches ≈ **0.26 ms**.
  Not worth the interpreter rewrite.
- **Loop-invariant hoisting (task idea 3).** Measured: the remaining loop
  bodies (`page.tags`, `page.toc`, `posts`, `tag.posts`, `p.tags`) reference
  only loop-varying vars (`t.*`, `h.*`, `loop.*`); there is nothing invariant
  to hoist. **~0 ms**.
- **Head/meta skeleton baking (part of task idea 1).** The `head`/`meta`
  templates (22,546 ops) have only page/tag conditionals as variable parts;
  baking their constant skeleton would save ~10k ops ≈ **0.23 ms**. Not built.
- **Fused single-pass renderer (v5's finding, re-confirmed).** The three
  passes over ~7.4 MB cost only ~1–2 ms; the cost is per-construct dispatch.

Total for ideas (1)–(3): the memo gave ~6 ms; fusion + hoisting + head/meta
baking could add at most ~0.5 ms, so the task's ≥10 ms bar for continuing
cannot be reached through template ops. **The remaining template-op pool is
only ~2.5 ms** (111,588 ops × ~22 ns/op, measured from the memo delta).

## Honest status: under-30 ms NOT reached

v6 is ~49 ms here (~65 ms graded net), ~7x above the under-7 ms proxy for
under-10 ms on the server. The remaining time is dominated by **Markdown
(~30 ms)** and layout output writing + JSON parsing, not template ops. A
further round would have to attack Markdown inline rendering, not templates.
v6 is correct, verified, and the fastest version built; whether it is worth
submitting over v5 (the current live entry) is the parent's call — it is
~11% faster, verified 3/3, grade-local passed, differential-tested, ASan
clean.

## Verification

- **Practice 3/3 byte-identical** (276 + 350 + 509 files), sha256
  `25980928b145f54712027939364a64c277098bc4528a2d524e0bc27a0275fb03`
  (same as v1–v5). Run twice, identical bytes.
- **Kit grade-local**: `{"cases_passed":3,"cases_total":3,"passed":1}`,
  checks 3 of 3, L1 regrade reproduced byte for byte.
- **Differential tests** vs house baseline (kit generator + oracle), seeds
  1, 2, 3, 7, 8, 10 — all 3/3.
- **ASan + UBSan clean** on practice + seed 7 (leak detection off: the arena
  is intentionally never freed).
- **SSE2 fallback** (`SG_NO_AVX2=1`): 3/3, identical bytes.
- **Clean directory** via `node main.ts` (N-API): 3/3.
- **`ldd`**: "not a dynamic executable" (fully static, stripped).
- **Ship size**: 1,528,013 bytes (LICENSE, README.md, main.ts, solve.js,
  sitegen, sitegen.node), under the 4 MiB cap. `src/` is not shipped.
