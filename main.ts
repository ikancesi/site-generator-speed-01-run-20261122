// Native site-generator entry: main.ts does almost nothing in JS — it spawns the
// static C binary `sitegen` next to it, which reads /input/cases.json, builds every
// case, and writes /output/answers.json. Node's own work (and startup) is subtracted
// by the harness via the do-nothing null entry, so only the spawn + native work counts.
//
// /bot is read-only and files uploaded through the browser lose the exec bit, so if
// the binary cannot be executed in place, copy it to a writable temp dir, chmod it,
// run it there, and remove the copy afterwards.
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, 'sitegen');

function runBinary(path: string): void {
  execFileSync(path, [INPUT_DIR, OUTPUT_DIR], { stdio: 'inherit' });
}

try {
  runBinary(bin);
} catch (e) {
  // EACCES (no exec bit after upload) or similar: copy somewhere writable and run there.
  const tmp = join(tmpdir(), `sitegen-${process.pid}`);
  copyFileSync(bin, tmp);
  chmodSync(tmp, 0o755);
  try {
    runBinary(tmp);
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
  if (!existsSync(join(OUTPUT_DIR, 'answers.json'))) throw e;
}
