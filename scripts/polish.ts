#!/usr/bin/env -S tsx
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runPolishAudit } from './polishAudit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.JUNO_POLISH_OUT ?? path.join(root, '.polish');
const framesDir = path.join(outDir, 'frames');
mkdirSync(framesDir, { recursive: true });

const results = runPolishAudit();
for (const result of results) {
  writeFileSync(path.join(framesDir, `${result.name}.txt`), `${result.frame}\n`);
  const failures = result.invariants.filter((check) => !check.pass);
  process.stdout.write(
    `${failures.length === 0 ? 'PASS' : 'FAIL'} ${result.name} (${result.columns}x${result.rows})` +
      `${failures.length === 0 ? '' : ` — ${failures.map((failure) => failure.name).join(', ')}`}\n`,
  );
}

const summary = {
  ok: results.every((result) => result.invariants.every((check) => check.pass)),
  generatedAt: new Date().toISOString(),
  cases: results.map(({ frame: _frame, ...result }) => ({
    ...result,
    frame: path.relative(root, path.join(framesDir, `${result.name}.txt`)),
  })),
};
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

if (!summary.ok) {
  for (const result of results) {
    for (const failure of result.invariants.filter((check) => !check.pass)) {
      process.stderr.write(`[polish:${result.name}] ${failure.name}: ${failure.detail}\n`);
    }
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`[polish] ${results.length} responsive frames passed; artifacts: ${path.relative(root, outDir)}\n`);
}
