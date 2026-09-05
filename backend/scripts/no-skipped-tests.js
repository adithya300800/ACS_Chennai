#!/usr/bin/env node
/**
 * no-skipped-tests.js
 *
 * LPR-004 guard + B-5 extension: fail CI if `.skip(` or `.only(` markers
 * appear in the production-boundary test suite without a corresponding
 * entry in the inventory. Background:
 *
 *   The SOL production-readiness reassessment (LPR-004) flagged that 14+
 *   backend suites containing 176+ tests were intentionally skipped to make
 *   CI green — a false-green signal for release. The original guard walked
 *   ONLY `__tests__/integration/` (which had zero files at the time), so it
 *   passed vacuously while the actual skipped unit suite went unmonitored.
 *
 *   This guard now covers BOTH tiers:
 *     - INTEGRATION tier (`__tests__/integration/`): completely forbidden.
 *       Re-enabling integration tests is a contract, not a TODO.
 *     - UNIT tier (`__tests__/*.test.js`, excluding `integration/`):
 *       `.skip(` is allowed ONLY if the file appears in the inventory at
 *       `__tests__/SKIPPED_TESTS.md`. Every new skip must add a row to that
 *       file (with a SOL-finding reference + reason). The inventory is the
 *       single source of truth.
 *
 *   `.only(` is forbidden in BOTH tiers — focused tests can mask real
 *   regressions.
 *
 * Exit codes:
 *   0 — no forbidden markers / every skip is inventoried
 *   1 — at least one forbidden marker OR an uninventoried skip
 *
 * Usage:
 *   node scripts/no-skipped-tests.js
 *   npm run test:no-skipped   (alias wired in package.json)
 *   npm test                  (runs via `pretest` script)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INTEGRATION_DIR = path.join(ROOT, '__tests__', 'integration');
const UNIT_DIR = path.join(ROOT, '__tests__');
const INVENTORY_PATH = path.join(ROOT, '__tests__', 'SKIPPED_TESTS.md');

const FORBIDDEN_MARKERS = [
  { pattern: /\.skip\s*\(/g, name: '.skip(' },
  { pattern: /\.only\s*\(/g, name: '.only(' },
];

function walk(dir, { exclude = [] } = {}) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, { exclude }));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out;
}

function scan(file) {
  const src = fs.readFileSync(file, 'utf8');
  const hits = [];
  for (const { pattern, name } of FORBIDDEN_MARKERS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(src)) !== null) {
      const upto = src.slice(0, m.index);
      const line = upto.split('\n').length;
      hits.push({ marker: name, line, snippet: src.split('\n')[line - 1].trim() });
    }
  }
  return hits;
}

/**
 * Parse SKIPPED_TESTS.md and return the set of relative paths (e.g.
 * `__tests__/dpr.cursor.test.js`) that are explicitly inventoried. The
 * inventory uses backtick-wrapped paths inside markdown table cells.
 *
 * DR-018 (audit): the original regex matched ANY backtick-wrapped
 * `.test.js` path in the markdown — including rows in the "Un-skipped
 * this round (proof of life)" section. That made a file that we
 * documented as un-skipped appear in the inventory, so a future
 * accidental `.skip` in that file would silently pass. Now we scope
 * the match to the "Skipped file inventory" section specifically:
 * the heading line below must precede the path. This keeps the
 * allow-list strictly shrinking.
 */
function loadInventory() {
  if (!fs.existsSync(INVENTORY_PATH)) return new Set();
  const src = fs.readFileSync(INVENTORY_PATH, 'utf8');
  const set = new Set();
  // Find the "Skipped file inventory" section heading (any level) and
  // match backtick-quoted .test.js paths that appear AFTER it. Any
  // path mentioned before that heading (in the "Un-skipped this round"
  // table, the prose intro, the "Re-enable playbook", etc.) is
  // excluded from the allow-list.
  const headingRe = /^#{1,6}\s+Skipped file inventory/m;
  const headingMatch = headingRe.exec(src);
  if (!headingMatch) return set;
  const tail = src.slice(headingMatch.index);
  const re = /`((?:__tests__\/)?[\w./-]+\.test\.js)`/g;
  let m;
  while ((m = re.exec(tail)) !== null) {
    set.add(m[1].startsWith('__tests__/') ? m[1] : `__tests__/${m[1]}`);
  }
  return set;
}

function main() {
  const integrationFiles = walk(INTEGRATION_DIR);
  const unitFiles = walk(UNIT_DIR, { exclude: ['integration', 'SKIPPED_TESTS.md', 'node_modules'] });

  const violations = [];

  // Tier 1: integration suite — completely forbidden.
  for (const file of integrationFiles) {
    const hits = scan(file);
    for (const h of hits) {
      violations.push({
        tier: 'integration',
        file: path.relative(ROOT, file),
        marker: h.marker,
        line: h.line,
        snippet: h.snippet,
        reason: 'integration tier — re-enable tests instead of skipping',
      });
    }
  }

  // Tier 2: unit suite — allowed only if file is in SKIPPED_TESTS.md.
  //
  // DR-018 (audit): the previous code lumped `.skip(` and `.only(` into
  // the same branch, so an inventoried file could contain `.only(`
  // without the guard firing. `.only(` focused-test runs can mask real
  // regressions — the script header documents both markers as
  // "FORBIDDEN_MARKERS" but only enforced it inconsistently. Now we
  // treat them separately:
  //   - `.skip(` in an inventoried file → allowed (the inventory row
  //     is the contract).
  //   - `.skip(` in a non-inventoried file → violation.
  //   - `.only(` ANYWHERE → unconditional violation. Focused runs are
  //     not part of the production-boundary CI path and must never
  //     reach a regular `npm test` invocation.
  const inventory = loadInventory();
  for (const file of unitFiles) {
    const rel = path.relative(ROOT, file);
    const hits = scan(file);
    if (hits.length === 0) continue;
    const onlyHits = hits.filter((h) => h.marker === '.only(');
    const skipHits = hits.filter((h) => h.marker === '.skip(');
    for (const h of onlyHits) {
      violations.push({
        tier: 'unit',
        file: rel,
        marker: h.marker,
        line: h.line,
        snippet: h.snippet,
        reason: 'unit suite — .only( is unconditionally forbidden (focused tests can mask regressions)',
      });
    }
    if (!inventory.has(rel)) {
      for (const h of skipHits) {
        violations.push({
          tier: 'unit',
          file: rel,
          marker: h.marker,
          line: h.line,
          snippet: h.snippet,
          reason: 'unit suite — file not in SKIPPED_TESTS.md inventory (add a row there first)',
        });
      }
    }
  }

  if (violations.length === 0) {
    const invCount = inventory.size;
    console.log(
      `[no-skipped-tests] OK: scanned ${integrationFiles.length} integration + ${unitFiles.length} unit file(s) — no forbidden markers; ${invCount} unit file(s) are inventoried.`
    );
    process.exit(0);
  }

  console.error('[no-skipped-tests] FAIL: forbidden .skip(/.only( markers found:');
  for (const v of violations) {
    console.error(`  [${v.tier}] ${v.file}:${v.line}  ${v.marker}  ${v.snippet}`);
    console.error(`         reason: ${v.reason}`);
  }
  console.error(
    `\n${violations.length} violation(s).\n` +
      `  - Integration-tier skips are unconditionally forbidden.\n` +
      `  - Unit-tier skips require the file to appear in __tests__/SKIPPED_TESTS.md\n` +
      `    (current inventory: ${inventory.size} file(s)). Add a row first, then re-run.`
  );
  process.exit(1);
}

main();
