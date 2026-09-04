#!/usr/bin/env node
/**
 * no-skipped-tests.js
 *
 * LPR-004 guard: fail CI if `.skip(` or `.only(` markers appear inside the
 * production-boundary integration test suite. Background:
 *
 *   The latest SOL production-readiness reassessment (LPR-004) flagged that
 *   14 backend suites containing 176 tests are intentionally skipped to make
 *   CI green. That's a false-green signal for release.
 *
 *   This guard makes it impossible to silently re-introduce `.skip(` /
 *   `.only(` markers in the **integration** suite (`__tests__/integration/`)
 *   — the suite that exercises the mounted Express app against a real DB
 *   and represents the production-boundary contract.
 *
 *   The unit suite (`__tests__/*.test.js`, minus `integration/`) is
 *   excluded: many of those are still skipped for legitimate reasons
 *   (see `__tests__/SKIPPED_TESTS.md`) and are tracked there. The guard
 *   only protects the freshly un-skipped integration tier from re-flipping
 *   to false-green.
 *
 * Exit codes:
 *   0 — no forbidden markers found, CI may proceed
 *   1 — at least one forbidden marker found, CI must fail
 *
 * Usage:
 *   node scripts/no-skipped-tests.js
 *   npm run test:no-skipped   (alias wired in package.json)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET_DIR = path.join(ROOT, '__tests__', 'integration');

const FORBIDDEN_MARKERS = [
  { pattern: /\.skip\s*\(/g, name: '.skip(' },
  { pattern: /\.only\s*\(/g, name: '.only(' },
];

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  // Strip line comments to avoid false positives in doc text — but DO NOT
  // strip block comments, since a developer could intentionally comment out
  // a .skip call as a "trick"; if the call survives anywhere, we flag it.
  const hits = [];
  for (const { pattern, name } of FORBIDDEN_MARKERS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(src)) !== null) {
      // Compute 1-based line number
      const upto = src.slice(0, m.index);
      const line = upto.split('\n').length;
      hits.push({ marker: name, line, snippet: src.split('\n')[line - 1].trim() });
    }
  }
  return hits;
}

function main() {
  const files = walk(TARGET_DIR);
  if (files.length === 0) {
    // No integration tests yet — don't fail the build, but warn.
    console.warn(
      `[no-skipped-tests] WARN: integration test directory not found at ${TARGET_DIR}`
    );
    process.exit(0);
  }

  const violations = [];
  for (const file of files) {
    const hits = scan(file);
    for (const h of hits) {
      violations.push({ file: path.relative(ROOT, file), ...h });
    }
  }

  if (violations.length === 0) {
    console.log(
      `[no-skipped-tests] OK: scanned ${files.length} integration test file(s) — no forbidden markers found.`
    );
    process.exit(0);
  }

  console.error('[no-skipped-tests] FAIL: forbidden .skip(/.only( markers found in integration suite:');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.marker}  ${v.snippet}`);
  }
  console.error(
    `\n${violations.length} violation(s). Per LPR-004, integration tests must not be skipped or focused.`
  );
  process.exit(1);
}

main();
