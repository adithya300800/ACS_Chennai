// DR-022 (Fresh-24 audit 2026-09-24): manpower serialization no longer
// round-trips when the trade name itself contains the reserved
// separators (em-dash U+2014 and pipe "|").
//
// Prior implementation (kept here as the legacy fallback):
//   on the wire:  "Trade — Count — Hours" joined by " | "
//   on read:      split on " | " then each row on " — "
//   → a trade like "Senior — Lead" serialized to "Senior — Lead — 6 — 8"
//     and parsed back as {trade:"Senior", count:"Lead", hours:"6"} — the
//     trailing "8" was silently dropped. A trade like "Pipe | Fitter"
//     split into two rows on read.
//
// Format v2 (this module):
//   on the wire:  same shape, but reserved characters in any field are
//                 backslash-escaped. The escape character is "\" itself.
//                 "|" → "\|", "—" → "\—", "\" → "\\".
//   on read:      split on UN-escaped " | " / " — ", then unescape each
//                 field token.
//
// Format detection: a stored string is treated as v2 (escape-aware) if
// it contains ANY backslash; otherwise the original naive split runs
// and the record round-trips through the same parse it always did.
// Existing ambiguous records therefore remain unchanged in the DB
// until a user explicitly reconciles them by editing the row builder
// (per the acceptance criterion).
//
// The escape character "\" never appears in legacy strings except
// when a user typed one literally as part of a trade name. In that
// case the v2 parser still round-trips the value correctly because
// the unescape pass only strips escape pairs whose second character
// is in {—, |, \}; any other "\X" sequence is left alone. Widening
// the detection from "\—"/"\|" to "any backslash" is therefore safe
// for both new records and the rare legacy record that contains a
// literal "\".

const ROW_SEP = '|';
const FIELD_SEP = '—'; // em dash
const ESCAPE = '\\';

// Split `str` on the single character `sep`, treating any instance of
// `ESCAPE + sep` (and any other escape pair) as a non-separator. The
// escape character itself is preserved in the returned pieces so the
// caller can post-process with `unescapeField` and re-serialize without
// losing round-trip identity.
function splitEscaped(str, sep) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === ESCAPE && i + 1 < str.length) {
      // Consume the two-character escape verbatim.
      buf += str[i] + str[i + 1];
      i += 2;
      continue;
    }
    if (ch === sep) {
      out.push(buf);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  out.push(buf);
  return out;
}

// Strip leading backslashes from any of "\", "—", "|". Other characters
// are returned unchanged.
function unescapeField(s) {
  // Character class intentionally contains the literal em-dash, not a
  // \u escape sequence — char-class syntax treats "—" as the four
  // characters \, u, 2, 0, 1, 4 individually.
  return s.replace(/\\([\\—|])/g, '$1');
}

// Prepend a backslash to any of "\", "—", "|" in `s`.
function escapeField(s) {
  return s.replace(/[\\—|]/g, '\\$&');
}

// Detect v2 (escape-aware) wire format. Any backslash is a reliable
// signal because the legacy serializer never emitted one — it produced
// only the three row-separator characters as plain text. (If a legacy
// record happens to contain a user-typed "\", the v2 parser still
// round-trips it correctly because the unescape pass only strips escape
// pairs whose second character is in {—, |, \}; any other "\X" sequence
// is left alone.)
function isV2Format(str) {
  return str.indexOf('\\') !== -1;
}

export function parseManpowerSummary(str) {
  if (!str || typeof str !== 'string') {
    return [{ trade: '', count: '', hours: '' }];
  }
  if (!isV2Format(str)) {
    // Legacy path — preserves existing ambiguous records unchanged.
    return str
      .split(ROW_SEP)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((segment) => {
        const parts = segment.split(FIELD_SEP).map((p) => p.trim());
        if (parts.length >= 3) {
          return { trade: parts[0], count: parts[1], hours: parts[2] };
        }
        // Fallback: legacy free-text — keep the whole string as the trade
        // field so the engineer can see + edit what was originally typed.
        return { trade: segment, count: '', hours: '' };
      });
  }
  // v2 path — split respects "\—" / "\|" escape pairs, then each field
  // is unescaped so the UI gets the literal trade/count/hours back.
  return splitEscaped(str, ROW_SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((segment) => {
      const parts = splitEscaped(segment, FIELD_SEP).map((p) => p.trim());
      if (parts.length >= 3) {
        return {
          trade: unescapeField(parts[0]),
          count: unescapeField(parts[1]),
          hours: unescapeField(parts[2]),
        };
      }
      // Partial row — keep the whole thing in the trade field so the
      // engineer can see what was originally typed.
      return { trade: unescapeField(segment), count: '', hours: '' };
    });
}

export function serializeManpowerRows(rows) {
  return rows
    .filter((r) => r && r.trade && String(r.trade).trim().length > 0)
    .map((r) => {
      const trade = escapeField(String(r.trade).trim());
      const count = escapeField(String(r.count || '').trim());
      const hours = escapeField(String(r.hours || '').trim());
      return `${trade} ${FIELD_SEP} ${count} ${FIELD_SEP} ${hours}`;
    })
    .join(` ${ROW_SEP} `);
}

// Exported for tests + audit tooling. Not consumed by DprSubmit.
export const MANPOWER_WIRE_FORMAT = {
  ROW_SEP,
  FIELD_SEP,
  ESCAPE,
  VERSION: 2,
};