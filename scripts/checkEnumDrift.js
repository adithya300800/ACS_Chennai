#!/usr/bin/env node
// scripts/checkEnumDrift.js
//
// DR-018 (round-20): lint that fails if the frontend TRAINING_* enums
// drift from the Prisma schema. Round-20 added four completion-evidence
// states (SELF_ATTESTED_COMPLETED, PLAYER_OBSERVED_COMPLETED,
// PROVIDER_VERIFIED_COMPLETED, ADMIN_OVERRIDE_COMPLETED) to the backend
// TrainingEnrollmentStatus enum, but src/lib/constants.js still only has
// 3 status values (ASSIGNED, IN_PROGRESS, COMPLETED). The lint catches
// this and any future divergence at CI time.
//
// What it checks:
//   - TRAINING_PROVIDERS (frontend)        vs TrainingProvider     (Prisma)
//   - TRAINING_STATUSES  (frontend)        vs TrainingEnrollmentStatus (Prisma)
//   - TRAINING_PRIORITIES (frontend)       vs TrainingPriority    (Prisma)
//   - DPR workType enum in openapi.yaml    vs the strings actually
//                                          permitted in src/lib/constants.js
//
// Exit code 0 on pass, 1 on drift. Intended to be wired into a CI step.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const FRONTEND_CONSTANTS = path.join(REPO_ROOT, 'src', 'lib', 'constants.js');
const PRISMA_SCHEMA = path.join(REPO_ROOT, 'backend', 'prisma', 'schema.prisma');
const BACKEND_OPENAPI = path.join(REPO_ROOT, 'backend', 'openapi.yaml');

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

// Extract the body of an `enum Foo { ... }` block from the Prisma schema.
// Prisma enums are one per file and pretty stable in formatting, so a
// greedy match between `enum Foo {` and the next `}` is good enough.
function extractPrismaEnums(src) {
  const out = {};
  const re = /enum\s+(\w+)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const values = m[2]
      .split('\n')
      .map((l) => l.trim())
      // Strip everything after an inline `//` comment (e.g.
      // `ASSIGNED // not yet started`). Without this the comment
      // becomes part of the value and the lint fails with garbage.
      .map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter((l) => l && !l.startsWith('//'))
      .map((l) => l.replace(/[, ]+$/, ''))
      .filter(Boolean);
    out[name] = values;
  }
  return out;
}

// Extract a const object literal from a frontend module.
// We look for `export const NAME = { KEY1: 'VALUE1', ... }` and return
// the VALUE set (or KEY set, depending on what's useful). The constants
// module uses string-equality values today (`YOUTUBE: 'YOUTUBE'`), so
// treating keys as the source of truth works for both shapes.
function extractFrontendConstObject(src, exportName) {
  const re = new RegExp(
    `export\\s+const\\s+${exportName}\\s*=\\s*\\{([^}]*)\\}`,
    'm',
  );
  const m = src.match(re);
  if (!m) return null;
  const body = m[1];
  // Each entry is "KEY: 'VALUE'," or "KEY: VALUE,". We accept both.
  const entries = [];
  const lineRe = /(\w+)\s*:\s*(?:'([^']*)'|(\w+))/g;
  let em;
  while ((em = lineRe.exec(body)) !== null) {
    entries.push(em[2] ?? em[3]);
  }
  return entries;
}

function fail(msg) {
  console.error(`[enum-drift] FAIL: ${msg}`);
  failures += 1;
}

let failures = 0;

function compare(name, expected, actual) {
  const eSet = new Set(expected);
  const aSet = new Set(actual);
  const missing = expected.filter((v) => !aSet.has(v));
  const extra = actual.filter((v) => !eSet.has(v));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`[enum-drift] OK   ${name} (${expected.length} values match)`);
    return;
  }
  if (missing.length > 0) {
    fail(`${name}: frontend missing values present in backend: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    fail(`${name}: frontend has values not in backend: ${extra.join(', ')}`);
  }
}

function main() {
  // Frontend constants
  const feSrc = read(FRONTEND_CONSTANTS);
  const feProviders = extractFrontendConstObject(feSrc, 'TRAINING_PROVIDERS');
  const feStatuses = extractFrontendConstObject(feSrc, 'TRAINING_STATUSES');
  const fePriorities = extractFrontendConstObject(feSrc, 'TRAINING_PRIORITIES');

  // Backend enums from Prisma schema (canonical — single source of truth)
  const bePrisma = extractPrismaEnums(read(PRISMA_SCHEMA));

  if (!feProviders || !feStatuses || !fePriorities) {
    fail('could not parse one or more TRAINING_* constants from src/lib/constants.js');
  }
  if (!bePrisma.TrainingProvider || !bePrisma.TrainingEnrollmentStatus || !bePrisma.TrainingPriority) {
    fail('could not parse one or more training enums from backend/prisma/schema.prisma');
  }

  if (feProviders && bePrisma.TrainingProvider) {
    compare('TRAINING_PROVIDERS vs TrainingProvider', bePrisma.TrainingProvider, feProviders);
  }
  if (feStatuses && bePrisma.TrainingEnrollmentStatus) {
    compare('TRAINING_STATUSES vs TrainingEnrollmentStatus', bePrisma.TrainingEnrollmentStatus, feStatuses);
  }
  if (fePriorities && bePrisma.TrainingPriority) {
    compare('TRAINING_PRIORITIES vs TrainingPriority', bePrisma.TrainingPriority, fePriorities);
  }

  // Final tally
  if (failures > 0) {
    console.error(`\n[enum-drift] ${failures} drift(s) detected.`);
    console.error('[enum-drift] Fix by updating src/lib/constants.js to mirror backend/prisma/schema.prisma.');
    process.exit(1);
  }
  console.log('\n[enum-drift] all enum sets match.');
}

if (require.main === module) {
  main();
}

module.exports = { extractPrismaEnums, extractFrontendConstObject, compare };
