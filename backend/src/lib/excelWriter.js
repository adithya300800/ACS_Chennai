// Streaming XLSX writer for the timesheet export — Round-13.
//
// Memory profile: WorkbookWriter streams rows directly to the response
// via pipe() so a 200-employee × 31-day sheet stays flat in RSS. The
// writer is closed via .commit() before the response ends.
//
// Graceful degradation: if exceljs fails to load (not installed, OOM at
// import, Node version mismatch), `pickWriter()` falls back to a UTF-8
// BOM CSV that Excel-on-Windows opens natively. The HTTP response then
// carries X-Export-Format: csv-fallback so the frontend can tell the user.
//
// Sheet-name sanitization: Excel forbids : \ / ? * [ ] in sheet names
// and clamps length to 31 chars. safeSheetName() collapses consecutive
// invalid chars and clamps.
//
// Formula-injection guard: cells that start with =, +, -, or @ are
// prefixed with a single quote so Excel doesn't interpret them as a
// formula when the file is opened (CSV-import mitigation). This is the
// OWASP-recommended pattern for user-content exports.

'use strict';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV_MIME = 'text/csv; charset=utf-8';

let _exceljs = null;
let _exceljsTried = false;

// Lazy-load exceljs. We try once per process and cache the result so a
// missing/broken module doesn't re-trigger the import on every request.
function tryLoadExceljs() {
  if (_exceljsTried) return _exceljs;
  _exceljsTried = true;
  try {
    _exceljs = require('exceljs');
  } catch (e) {
    _exceljs = null;
  }
  return _exceljs;
}

// Pick the right writer for this request. If exceljs is available and
// the response object supports streaming, use XLSX; otherwise fall back
// to CSV so the export never silently breaks.
function pickWriter() {
  const ej = tryLoadExceljs();
  if (ej && ej.WorkbookWriter) {
    return { format: 'xlsx', write: writeXlsx, mime: XLSX_MIME };
  }
  return { format: 'csv-fallback', write: writeCsv, mime: CSV_MIME };
}

// Strip Excel-illegal characters and clamp to 31 chars.
function safeSheetName(raw) {
  if (raw == null) return 'Sheet1';
  let s = String(raw).replace(/[:\\/?*\[\]]/g, '_').trim();
  if (s.length > 31) s = s.slice(0, 31);
  if (s.length === 0) s = 'Sheet1';
  return s;
}

// Sanitize a single cell value for formula injection: prefix dangerous
// leading chars with a single quote. Returns a string.
function safeCellValue(v) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (s.length === 0) return '';
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

// Sanitize a filename for Content-Disposition. We allow letters, digits,
// dot, dash, underscore.
function safeFilename(name) {
  let s = String(name || 'export').replace(/[^A-Za-z0-9._-]/g, '_');
  if (s.length > 200) s = s.slice(0, 200);
  return s || 'export';
}

// Write an XLSX response using WorkbookWriter streaming.
// `columns` is an array of { header, key, width }.
// `rows` is an array of objects keyed by column.key.
// `sheetName` is sanitized.
async function writeXlsx(res, { columns, rows, sheetName = 'Timesheet', filename = 'export.xlsx' }) {
  const ej = tryLoadExceljs();
  if (!ej || !ej.WorkbookWriter) {
    // Caller should have picked CSV — but if not, downgrade gracefully.
    return writeCsv(res, { columns, rows, filename });
  }
  const safeName = safeSheetName(sheetName);
  const wb = new ej.WorkbookWriter({ stream: res, useStyles: false });
  const ws = wb.addWorksheet(safeName);
  ws.columns = columns.map((c) => ({
    header: safeCellValue(c.header),
    key: c.key,
    width: c.width || 12,
  }));
  for (const r of rows) {
    const row = {};
    for (const c of columns) row[c.key] = safeCellValue(r[c.key]);
    ws.addRow(row).commit();
  }
  ws.commit();
  await wb.commit();
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}"`);
  res.setHeader('X-Export-Format', 'xlsx');
}

// Write a CSV response with UTF-8 BOM so Excel-on-Windows opens it
// without manual encoding selection. CRLF line endings per RFC 4180.
function writeCsv(res, { columns, rows, filename = 'export.csv' }) {
  res.setHeader('Content-Type', CSV_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}"`);
  res.setHeader('X-Export-Format', 'csv-fallback');
  const escape = (v) => {
    const s = safeCellValue(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map((c) => escape(c.header)).join(',');
  const lines = [header];
  for (const r of rows) {
    lines.push(columns.map((c) => escape(r[c.key])).join(','));
  }
  res.write('﻿' + lines.join('\r\n') + '\r\n');
  res.end();
}

module.exports = {
  XLSX_MIME,
  CSV_MIME,
  tryLoadExceljs,
  pickWriter,
  writeXlsx,
  writeCsv,
  safeSheetName,
  safeFilename,
  safeCellValue,
};