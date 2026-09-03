#!/usr/bin/env node
// scripts/generateOpenapi.js
//
// DR-018 (round-20): auto-generate openapi.yaml from the live Express router
// mounts. The previous hand-maintained openapi.{yaml,json} pair drifted out
// of sync with the routes — round-12 added inspection, round-13 added
// attendance export + leave, round-14 added training, and round-18 added
// bulk-review endpoints that the spec never picked up.
//
// This script walks the same router files the server mounts in src/index.js
// and emits openapi.yaml with one stub path per (method, route) pair. The
// intent is to make drift impossible going forward: any new endpoint shows
// up in the spec on the next `npm run openapi:gen` run, even if a human
// forgets to update the YAML.
//
// What this script DOES emit:
//   - paths: one entry per mounted (method, path) pair
//   - the response schema is left as a generic 200 OK with `additionalProperties`
//     so the spec is still valid (and still useful for code-gen) without
//     pretending we know every response shape.
//   - tags are inferred from the router filename (dpr.js → DPR, leave.js → Leave)
//
// What this script does NOT emit (TODO follow-ups):
//   - requestBody schemas
//   - per-route response schemas (e.g. Dpr vs AttendanceRecord)
//   - security requirements per route
//   - enum values for status fields (see ../openapi.yaml — the existing
//     hand-maintained enums stay until we replace them)
//
// Until those are added, this is a stub — but a stub that cannot silently
// rot, which is the whole point.

'use strict';

const fs = require('fs');
const path = require('path');

// Load backend/.env so route modules that validate env vars at module-load
// time (auth.js checks JWT_SECRET/JWT_REFRESH_SECRET) can be required
// without the server actually starting. Without this the generator errors
// out on the first route file with "JWT_SECRET must be set".
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// We deliberately require the route files directly. They export an Express
// router that we can introspect via .stack. We don't need to start the
// server or wire up middleware — just enumerate the routes.
//
// Note: route files import db clients + middleware. The require below will
// fail if `require('dotenv').config()` in src/index.js hasn't run. The
// generator does NOT load src/index.js — it loads only the per-route
// modules. If any of them transitively require prisma or other heavy
// modules at module-load time, this script will fail in the same way the
// server would. That's fine; it surfaces a real bug early.
const ROUTE_FILES = [
  { file: 'auth.js',       mount: '/api/auth',         tag: 'Auth' },
  { file: 'attendance.js', mount: '/api/attendance',   tag: 'Attendance' },
  { file: 'leave.js',      mount: '/api/leave',        tag: 'Leave' },
  { file: 'training.js',   mount: '/api/training',     tag: 'Training' },
  { file: 'dpr.js',        mount: '/api/dpr',          tag: 'DPR' },
  { file: 'inspection.js', mount: '/api/inspection',   tag: 'Inspection' },
  { file: 'contact.js',    mount: '/api/contact',      tag: 'Contact' },
  // diag.js is intentionally omitted — internal diagnostic endpoint,
  // not part of the public contract.
];

const HEALTH_PROBES = [
  { path: '/health', summary: 'Liveness probe (no downstream dependencies)', tag: 'Health' },
  { path: '/ready',  summary: 'Readiness probe — verifies Postgres and R2',   tag: 'Health' },
  { path: '/version', summary: 'Deployment metadata (internal token required)', tag: 'Health' },
];

function walkRouter(router, mount) {
  const out = [];
  // Express 4 stores registered handlers on .stack. Each entry has
  // .route (only set for router.METHOD() calls) or .name (only set for
  // router.use() / middleware). We only care about .route.
  const layers = (router && router.stack) || [];
  for (const layer of layers) {
    if (!layer.route) continue;
    const route = layer.route;
    const methods = Object.keys(route.methods).filter((m) => m !== '_all');
    for (const method of methods) {
      const fullPath = (mount + (route.path === '/' ? '' : route.path))
        .replace(/\/+/g, '/');
      out.push({ method: method.toUpperCase(), path: fullPath });
    }
  }
  return out;
}

function routesToYaml(routes, tag) {
  const lines = [];
  // Group by path so the YAML reads naturally (GET + PUT /:id together).
  const byPath = new Map();
  for (const r of routes) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r.method);
  }
  for (const [fullPath, methods] of byPath) {
    lines.push(`  ${fullPath}:`);
    for (const method of methods) {
      lines.push(`    ${method.toLowerCase()}:`);
      lines.push(`      summary: "${method} ${fullPath}"`);
      lines.push(`      tags: [${tag}]`);
      lines.push('      responses:');
      lines.push("        '200':");
      lines.push('          description: OK');
      lines.push('          content:');
      lines.push('            application/json:');
      lines.push('              schema:');
      lines.push('                type: object');
      lines.push('                additionalProperties: true');
      lines.push('        \'401\':');
      lines.push('          $ref: \'#/components/responses/Unauthorized\'');
    }
  }
  return lines.join('\n');
}

function main() {
  const routesDir = path.join(__dirname, '..', 'src', 'routes');
  const out = [];
  out.push('# Auto-generated by scripts/generateOpenapi.js — do NOT hand-edit.');
  out.push('# Run `npm run openapi:gen` from backend/ to refresh.');
  out.push('openapi: 3.0.3');
  out.push('info:');
  out.push('  title: ACS Chennai Portal API');
  out.push('  description: |');
  out.push('    Auto-generated from the Express router mounts.');
  out.push('    Run `npm run openapi:gen` to refresh after route changes.');
  out.push('  version: 1.0.0');
  out.push('servers:');
  out.push('  - url: https://acs-chennai.onrender.com');
  out.push('    description: Render production');
  out.push('  - url: http://localhost:8080');
  out.push('    description: Local development');
  out.push('components:');
  out.push('  securitySchemes:');
  out.push('    bearerAuth:');
  out.push('      type: http');
  out.push('      scheme: bearer');
  out.push('      bearerFormat: JWT');
  out.push('  responses:');
  out.push('    Unauthorized:');
  out.push('      description: Missing or invalid JWT');
  out.push('      content:');
  out.push('        application/json:');
  out.push('          schema:');
  out.push('            type: object');
  out.push('            properties:');
  out.push('              error: { type: string }');
  out.push('security:');
  out.push('  - bearerAuth: []');
  out.push('');

  // Health probes — not mounted via routers, defined inline in src/index.js
  out.push('paths:');
  for (const probe of HEALTH_PROBES) {
    out.push(`  ${probe.path}:`);
    out.push('    get:');
    out.push(`      summary: "${probe.summary}"`);
    out.push(`      tags: [${probe.tag}]`);
    out.push('      security: []');
    out.push('      responses:');
    out.push("        '200':");
    out.push('          description: OK');
  }
  out.push('');

  // Per-router routes
  for (const entry of ROUTE_FILES) {
    const fullPath = path.join(routesDir, entry.file);
    if (!fs.existsSync(fullPath)) {
      console.error(`[openapi:gen] SKIP ${entry.file} (file not found)`);
      continue;
    }
    let router;
    try {
      router = require(fullPath);
    } catch (err) {
      console.error(`[openapi:gen] FAIL loading ${entry.file}: ${err.message}`);
      process.exit(1);
    }
    const routes = walkRouter(router, entry.mount);
    if (routes.length === 0) {
      console.error(`[openapi:gen] WARN ${entry.file} has no routes`);
      continue;
    }
    out.push(routesToYaml(routes, entry.tag));
    console.log(`[openapi:gen] ${entry.file}: ${routes.length} route(s) → ${entry.mount}`);
  }

  const targetPath = path.join(__dirname, '..', 'openapi.generated.yaml');
  fs.writeFileSync(targetPath, out.join('\n') + '\n', 'utf8');
  console.log(`[openapi:gen] wrote ${targetPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { walkRouter, routesToYaml };
