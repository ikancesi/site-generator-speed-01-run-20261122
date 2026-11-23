# site-generator-speed-01-run-20261122 — native entry v8

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ikancesi/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ikancesi/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A native (C) drop-in for makefun-site 1.0.0, byte-identical output, built for the
make.fun bounty "Build a static site faster, 22 November 2026" ($100 in USDC).

This is v8, an eighth optimization round on top of v6 (`../native-v6/`, ~47 ms
binary alone on this VM). It is ~2 ms faster than v6, but under-30 ms — and
the under-7 ms proxy for under-10 ms on the server — was NOT reached; see
"Honest status".

The engine runs **in-process as an N-API addon** (`sitegen.node`) loaded by
`main.ts`, with the standalone static binary (`sitegen`) as the fallback if the
addon cannot load. Same driver pattern and exec-bit fallback as v4–v7.

## What v8 changed

Measured first, with gprof over 50 in-process runs plus the phase timers:
markdown ~30 ms, layouts ~13.5 ms, JSON parse ~7 ms. Then each change below
was measured separately with the interleaved A/B bench (child CPU user+sys,
median of 7–15, pinned 1 CPU) and kept only if it moved the number.

1. **Word-at-a-time FNV hash (`src/util.c`).** `strmap_get`/`put` +
   `slugset_has`/`add` were ~6.7% of profiled time; the hash itself was a
   per-byte scalar multiply chain. FNV-1a now consumes whole 8-byte words
   (plus a 4-byte word and a byte tail, plus a length mix). Reads stay
   inside the string: a word is only read when >= 8 bytes remain. Bucket
   order is not observable (`slugset_keys` is documented unordered and its
   only caller sorts), so changing the hash is semantics-preserving.
   **Effect: ~−1.7 ms.**
2. **Small initial hash sets/maps (`src/util.c`).** `slugset_new` /
   `strmap_new` started at 64 slots (1–1.5 KB zeroed per call); the hot
   call sites create one set per file / per post, usually holding <= 5
   entries. Initial capacity is now 8 (growth by doubling as before).
   **Effect: ~0 ms** (the gprof share was mostly `-pg` instrumentation
   artifact) — kept anyway: less arena use, no downside measured.
3. **JSON decoder (`src/json_stream.c`).** `decode_str_avx2` started its
   output buffer at 1024 bytes, forcing 1024→2048→4096 growth copies for
   every ~2.7 KB markdown body; it now starts at 4096. The per-escape
   bounds check is hoisted: 32 bytes of write room are ensured once per
   loop iteration, so the single-byte escape writes are unchecked.
   **Effect: ~0 ms** (within noise) — kept: fewer copies, simpler loop.
   (One build in this round briefly shipped a broken escape literal from
   a regex edit; it was caught by the compiler, fixed, and the numbers
   below are from the correct build.)
4. **Scanner short-input path (`src/sg.h`).** `find_special_json_avx2` /
   `find_escjson_avx2` created all their vector constants before checking
   length, so short inputs (< 32 bytes, the common case for template
   variable values) paid full setup. They now take the scalar tail
   immediately for n < 32. **Effect: ~0 ms** — kept.
5. **Computed-goto template dispatch (`src/tpl.c`).** `interpret()` was a
   `switch`/`break` loop; it is now threaded dispatch (GCC labels-as-values,
   one jump from each handler to the next). Every case body is identical;
   only the dispatch changed. **Effect: ~−0.3 ms.**

## What was measured and deliberately NOT adopted

- **Path-passing N-API (task idea 1).** Already in place since v4: `main.ts`
  passes only paths; the addon mmaps `cases.json`, parses JSON in C,
  renders, and writev's `answers.json` directly. There is no JS
  `JSON.parse` / `JSON.stringify` / structured-clone round-trip left to
  remove.
- **Zero-copy slices (task idea 3).** Already in place since v2: the
  streaming JSON parser returns zero-copy slices of the mmap'd input for
  escape-free strings.
- **Streaming single-pass output (task idea 2).** Measured, not built: the
  page buffers start at 16 KB and the output-size distribution shows only
  22 of 1135 files exceed it, so total Buf growth copies are ~360 KB
  (~0.1 ms). A streaming writer would touch each output byte the same
  number of times (md.html → output is one read + one write either way);
  it only saves the growth copies and the iovec assembly, ~0.2–0.3 ms at
  most, for an invasive restructure of `build_case` / `engine.c`.
- **Fused block+inline Markdown (task idea 4).** Not built: v7 measured
  block fusion at ≤1–2 ms saving at high semantic risk (emphasis spanning
  line boundaries needs carry-over state), and its single-pass inline
  renderer was already slower than v6. The inline cost is per-construct
  dispatch + memory traffic, not scan overhead.
- **Compiler flags.** Swept `-O3 -flto` (shipped) vs `-O3` no-LTO vs
  `-O2 -flto`: LTO+O3 is fastest (44.7 vs 45.2 vs 46.0 ms median in one
  11-run interleaved set). PGO was measured slower in v4 and not retried.

## Measured times (this VM, pinned to 1 CPU with `taskset -c 0`)

Binary alone, median of 15 fresh runs (interleaved A/B vs v6, child CPU user+sys):

| entry | binary alone | graded net via `node main.ts` |
|---|---|---|
| **v8** | **~43.5–44.7 ms** | **~61.1 ms** |
| v6 | ~45.5–47.5 ms | ~63.1 ms |
| v5 | ~55 ms | ~72 ms |
| house baseline | — | ~1,240 ms |

"Graded net" = raw `node main.ts` CPU minus the do-nothing `.ts` null entry
(~148 ms), the same subtraction the harness applies. v8 is ~2 ms faster than
v6 on the binary and on the graded number — about a 4–5% improvement.
Absolute medians drift a few ms between runs on this throttled VM; the
~2 ms gap is consistent across interleaved runs.

## Per-change effect table (binary alone, median, interleaved A/B vs v6)

| change | effect |
|---|---|
| v6 baseline | ~45.5–47.5 ms |
| word-at-a-time FNV + small initial sets | ~−1.7 ms |
| JSON decoder reserve + unchecked escapes | ~0 ms |
| scanner short-input path | ~0 ms |
| computed-goto template dispatch | ~−0.3 ms |
| **v8 final** | **~43.5–44.7 ms vs v6 ~45.5–47.5 ms** |

## Honest status: under-30 ms NOT reached, under-10 ms NOT reached

v8 is ~44 ms here (~61 ms graded net), ~6x above the under-7 ms proxy for
under-10 ms on the server. The remaining time is spread across the whole
pipeline (markdown ~30 ms, layouts ~13 ms, JSON parse ~7 ms) and is
dominated by per-construct dispatch plus memory traffic (~40–50 MB touched
per run: input, decoded copies, markdown HTML, escaped page buffers,
writev). Every idea in this round that attacked one phase moved the number
by ~0–2 ms; the per-phase costs are all real work that cannot be skipped
without changing the output. Under-10 ms would need the output to be mostly
copied rather than computed (~1.3 ns/byte), which this workload does not
allow: every page's markdown must be rendered and every template op
executed. A future round would need a fundamentally different approach
(e.g. precomputing shared output at a coarser grain), and no such approach
was found in this round.

v8 is correct, verified, and the fastest version built; whether it is worth
submitting over v6 (the current live entry) is the parent's call — it is
~4–5% faster, verified 3/3, grade-local passed, differential-tested, ASan
clean.

## Verification

- **Practice 3/3 byte-identical** (276 + 350 + 509 files), sha256
  `25980928b145f54712027939364a64c277098bc4528a2d524e0bc27a0275fb03`
  (same as v1–v7). Run twice, identical bytes.
- **Kit grade-local**: `{"cases_passed":3,"cases_total":3,"passed":1}`,
  checks 3 of 3, L1 regrade reproduced byte for byte.
- **Differential tests** vs house baseline (kit generator + oracle), seeds
  1, 2, 3, 7, 8, 10 — all 3/3.
- **ASan + UBSan clean** on practice (leak detection off: the arena
  is intentionally never freed).
- **SSE2 fallback** (`SG_NO_AVX2=1`): 3/3, identical bytes.
- **Clean directory** via `node main.ts` (N-API): rc 0, correct sha256.
- **`ldd`**: "not a dynamic executable" (fully static, stripped).
- **Ship size**: 1,531,735 bytes (LICENSE, README.md, main.ts, solve.js,
  sitegen, sitegen.node), under the 4 MiB cap. `src/` is not shipped.
  Build: `./build.sh nopgo` (LTO+O3, no PGO — PGO measured slower in v4).

## Recommendation

**Submit v8 only if a ~2 ms (~4%) improvement is worth a new submission.**
It is strictly faster than v6 on every interleaved measurement, correct, and
fully verified — there is no correctness reason not to submit it. But it does
not change the competitive picture: v6 scored 110,000 us on the server
(rank 44), and v8's ~4% would move that to roughly ~105,000 us, still far
from the 20,000 us reward line and the under-10 ms target. The under-10 ms
goal was not reached by any means tried in v6–v8, and further rounds on this
architecture are expected to yield ~0–2 ms each.
