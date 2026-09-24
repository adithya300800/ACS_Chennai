/**
 * §8.7 (Fresh24 wave-4 batch-A) — error-copy smoke gate.
 *
 * What this catches
 * -----------------
 *   The Fresh24 audit found that "generic raw UNKNOWN_FIELDS make users
 *   blame themselves or storage." DR-024 (Wave 2) split the certification
 *   payload builders so the literal string should no longer leak. This
 *   test pins that contract: every `UNKNOWN_FIELDS` literal in the
 *   frontend source MUST sit in one of the developer-only sinks listed
 *   below — never in a user-facing surface.
 *
 * What this does NOT catch (out of scope, by design)
 * ---------------------------------------------------
 *   - The literal leaking at runtime from a server response into a toast.
 *     That's an integration concern; see DR-024 / round-20 audit for the
 *     separation of error-mapping between server and client. If the
 *     server ever starts sending a string that contains "UNKNOWN_FIELDS"
 *     and the client renders it raw, that would not trip THIS test, but
 *     it would trip the integration smoke on the live bundle.
 *   - Color contrast / a11y of the user-facing error string. The a11y
 *     smoke (`a11y.smoke.test.js`) already covers that class.
 *
 * What is ALLOWED (developer-only sinks)
 * --------------------------------------
 *   1. Single-line // comments.
 *   2. Block comments (multi-line slash-star banners) and JSDoc
 *      headers (any `*`-prefixed line).
 *   3. Text inside a `<details>...</details>` JSX block — the audit
 *      explicitly approved collapsibles for diagnostics.
 *   4. Strings inside `console.error(...)` or `console.warn(...)`
 *      calls (developer logs only; not user-facing).
 *
 * What is BLOCKED (would fail this gate)
 * ---------------------------------------
 *   - Plain JSX text: `<div>UNKNOWN_FIELDS</div>` or
 *     `<p>Got UNKNOWN_FIELDS error</p>`.
 *   - Toast strings, alert() messages, throw new Error("UNKNOWN_FIELDS").
 *   - <title>, <h1>, aria-label, alt text, button children.
 *   - Object keys or values rendered through any UI surface.
 *
 * Comment-filtering lesson (Wave 3)
 * ---------------------------------
 *   Bare documentation blocks (top-of-file headers, JSDoc banners) would
 *   otherwise false-positive. We strip `//`-prefixed, `*`-prefixed, and
 *   `/*`-prefixed lines BEFORE the regex search — same fix that Wave 3
 *   applied to the dr031 / dr032 / db-recover source-text pins. See
 *   `verification/2026-09-24-wave3/REPORT.md`.
 *
 * Run: `npm test -- --testPathPattern='error-copy.smoke'`
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const SRC_DIR = join(__dirname, '..'); // repo-absolute src/

// ─── helpers ────────────────────────────────────────────────────────────

/** Walk `dir` collecting .js / .jsx files, skipping node_modules and tests. */
function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (entry === 'node_modules' || entry === '__tests__') continue;
    if (st.isDirectory()) {
      walkJs(full, out);
    } else if (/\.(js|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Wave-3 lesson: filter comment lines BEFORE regex matching so
 * documentation blocks (top-of-file JSDoc, trailing rationale
 * comments, etc.) don't false-positive.
 */
function stripComments(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trimStart();
      if (t.startsWith('//')) return false;
      if (t.startsWith('/*')) return false;
      if (t.startsWith('*')) return false; // continuation of /* ... */
      return true;
    })
    .join('\n');
}

/**
 * True iff `lineIdx` in `sourceLines` sits inside an open
 * `<details>...</details>` JSX block. Crude depth-tracker but
 * adequate for a smoke gate.
 */
function isInsideDetails(sourceLines, lineIdx) {
  // Walk backwards tracking depth. -1 crossing on `<details` means
  // we're inside; +1 crossing on `</details>` means we're outside.
  let depth = 0;
  for (let i = lineIdx; i >= 0; i--) {
    const line = sourceLines[i];
    if (/<\/details>/.test(line)) depth += 1;
    if (/<details[\s>]/.test(line)) {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return false;
}

/**
 * True iff `lineIdx` is part of a `console.error(...)` or
 * `console.warn(...)` call (developer log). Looks back up to 4 lines
 * for the call opener; looks at the same line for the argument.
 */
function isInsideConsoleCall(sourceLines, lineIdx) {
  const start = Math.max(0, lineIdx - 4);
  for (let i = start; i <= lineIdx; i++) {
    if (/console\.(error|warn)\s*\(/.test(sourceLines[i] || '')) return true;
  }
  return false;
}

/** Scan one file for UNKNOWN_FIELDS leaks. */
function findLeaks(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const filtered = stripComments(raw);
  const sourceLines = raw.split('\n');
  const leaks = [];
  filtered.split('\n').forEach((line, i) => {
    if (!line.includes('UNKNOWN_FIELDS')) return;
    if (isInsideDetails(sourceLines, i)) return;
    if (isInsideConsoleCall(sourceLines, i)) return;
    leaks.push({
      file: filePath,
      line: i + 1,
      content: line.trim(),
    });
  });
  return leaks;
}

// ─── the gate ───────────────────────────────────────────────────────────

describe('§8.7 — error-copy smoke gate (no UNKNOWN_FIELDS leak to user)', () => {
  const targets = walkJs(SRC_DIR);

  it('walks the source tree (sanity)', () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  test.each(targets)(
    'no user-facing UNKNOWN_FIELDS in %s',
    (file) => {
      const leaks = findLeaks(file);
      if (leaks.length === 0) return;
      const msg = leaks
        .map((l) => `  ${l.file}:${l.line}  ${l.content}`)
        .join('\n');
      throw new Error(
        `UNKNOWN_FIELDS leaked to a user-facing surface:\n${msg}\n\n` +
          `Allowed locations only: <details>...</details>, ` +
          `console.error(...), console.warn(...), or comments. ` +
          `If this is a documentation comment, ensure it starts with ` +
          `// or * so the comment-filter strips it.`
      );
    }
  );
});