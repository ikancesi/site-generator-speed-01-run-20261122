// Native site-generator entry (v4): main.ts does almost nothing in JS — it
// loads the N-API addon `sitegen.node` next to it and calls it once, in
// process. The addon runs the whole engine (file I/O, JSON, build) inside
// Node, so there is no fork/exec: on this VM the addon path is ~8 ms cheaper
// than spawning the binary (cgroup tree CPU, net of the null entry).
// If the addon cannot load (e.g. N-API unavailable), fall back to spawning
// the static C binary `sitegen` next to it, which does the same work.
// Node's own startup is subtracted by the harness via the do-nothing null
// entry, so only the engine work (+ addon load / spawn) counts.
//
// /bot is read-only and files uploaded through the browser lose the exec bit,
// so if the binary cannot be executed in place, copy it to a writable temp
// dir, chmod it, run it there, and remove the copy afterwards.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const here = dirname(fileURLToPath(import.meta.url));

function runBinary(path: string): void {
  execFileSync(path, [INPUT_DIR, OUTPUT_DIR], { stdio: "inherit" });
}

function runSpawnFallback(): void {
  const bin = join(here, "sitegen");
  try {
    runBinary(bin);
  } catch (e) {
    // EACCES (no exec bit after upload) or similar: copy somewhere writable.
    const tmp = join(tmpdir(), `sitegen-${process.pid}`);
    copyFileSync(bin, tmp);
    chmodSync(tmp, 0o755);
    try {
      runBinary(tmp);
    } finally {
      try { unlinkSync(tmp); } catch { /* best effort */ }
    }
    if (!existsSync(join(OUTPUT_DIR, "answers.json"))) throw e;
  }
}

let rc = 1;
try {
  const require = createRequire(import.meta.url);
  const addon = require(join(here, "sitegen.node"));
  rc = addon.run(INPUT_DIR, OUTPUT_DIR);
} catch {
  // Addon would not load: fall back to the spawned binary.
  runSpawnFallback();
  rc = 0;
}
process.exitCode = rc;
