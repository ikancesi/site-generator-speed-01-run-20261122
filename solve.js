// solve.js — the run(input) contract for this entry, backed by the same native
// binary the timed path (main.ts) uses. Not on the timed path: main.ts spawns the
// binary once for all cases, so it never pays Node's JSON.parse of cases.json.
// run() is for contract completeness / local testing: one case at a time.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function run(input) {
  const dir = mkdtempSync(join(tmpdir(), 'sitegen-case-'));
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  mkdirSync(inDir);
  mkdirSync(outDir);
  writeFileSync(join(inDir, 'cases.json'), JSON.stringify([{ id: 'x', input }]));
  let bin = join(here, 'sitegen');
  try {
    execFileSync(bin, [inDir, outDir], { stdio: 'pipe' });
  } catch {
    // No exec bit after upload: copy the binary somewhere writable and run the copy.
    const tmp = join(dir, 'sitegen');
    copyFileSync(bin, tmp);
    chmodSync(tmp, 0o755);
    execFileSync(tmp, [inDir, outDir], { stdio: 'pipe' });
  }
  const answers = JSON.parse(readFileSync(join(outDir, 'answers.json'), 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return answers[0];
}
