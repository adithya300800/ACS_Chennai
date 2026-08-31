import React, { useState, useId, useMemo } from 'react';

// Round-12: user-added ad-hoc sections on the DPR.
//
// Site engineers in TN PMC projects frequently need to record ad-hoc info
// that doesn't fit the standard daily-narrative fields (RMC pour records,
// equipment log, weather log, client visit log, IR/SI status, material
// consumption, daily hindrances, slump cone records). Rather than ship N
// fixed fields and grow the schema forever, this component lets the user
// add:
//
//   - Text section:  title + multi-line content
//   - Table section:  title + N columns (1..6) + N rows + editable grid
//
// Each section is stored in DPR.customSections (JSON). The backend validator
// caps sections at 20, columns at 6, rows at 200, and string cells at 500
// chars (see backend/src/routes/dpr.js validateCustomSections).
//
// Component contract:
//
//   value:    Array<{ id, type, title, content?, columns?, rows? }>
//   onChange: (next) => void
//
// The component is fully controlled — parent owns state, this component
// only emits changes. Stays in sync with DRAFT persistence in DprSubmit.

const COL_MAX = 6;
const ROW_MAX = 200;
const TITLE_MAX = 120;
const TEXT_MAX = 5000;
const CELL_MAX = 500;

function newId() {
  // crypto.randomUUID is supported in modern browsers + Node 19+. Falls
  // back to a timestamp+random string for older runtimes so a stale browser
  // doesn't break the form.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `sec-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

export default function DprCustomSection({ value = [], onChange }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState(null); // section id whose editor is expanded

  const sections = Array.isArray(value) ? value : [];

  const emit = (next) => {
    if (typeof onChange === 'function') onChange(next);
  };

  const addSection = (type) => {
    if (sections.length >= 20) return;
    const id = newId();
    const seed = type === 'text'
      ? { id, type: 'text', title: '', content: '' }
      : { id, type: 'table', title: '', columns: ['Column 1', 'Column 2'], rows: [['', '']] };
    const next = [...sections, seed];
    emit(next);
    setEditingId(id);
    setPickerOpen(false);
  };

  const updateSection = (id, patch) => {
    emit(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  const removeSection = (id) => {
    emit(sections.filter((s) => s.id !== id));
    if (editingId === id) setEditingId(null);
  };

  return (
    <div className="dpr-custom-sections">
      <label className="section-label">Custom Sections</label>
      <p style={{ fontSize: '0.8rem', color: 'var(--steel)', margin: '0.25rem 0 0.75rem' }}>
        Add ad-hoc text blocks or tables for site-specific records (RMC pour log,
        equipment on site, client visit, daily hindrances, slump cone record, etc.).
        Title and contents are saved with your DPR.
      </p>

      {sections.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '0.75rem' }}>
          {sections.map((s) => (
            <CustomSectionCard
              key={s.id}
              section={s}
              editing={editingId === s.id}
              onEdit={() => setEditingId(s.id)}
              onCollapse={() => setEditingId(null)}
              onUpdate={(patch) => updateSection(s.id, patch)}
              onRemove={() => removeSection(s.id)}
            />
          ))}
        </div>
      )}

      {!pickerOpen && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setPickerOpen(true)}
          disabled={sections.length >= 20}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}
        >
          <span aria-hidden="true" style={{ fontSize: '1.1rem', lineHeight: 1 }}>+</span>
          Add Section
        </button>
      )}

      {pickerOpen && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            padding: '0.75rem',
            background: '#f8fafc',
            border: '1px dashed #cbd5e1',
            borderRadius: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '0.85rem', color: 'var(--steel)' }}>Add a:</span>
          <button type="button" className="btn btn-sm" onClick={() => addSection('text')}>
            📝 Text section
          </button>
          <button type="button" className="btn btn-sm" onClick={() => addSection('table')}>
            📊 Table
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setPickerOpen(false)}
            aria-label="Cancel"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function CustomSectionCard({ section, editing, onEdit, onCollapse, onUpdate, onRemove }) {
  const titleId = useId();
  const summary = useMemo(() => {
    if (section.type === 'text') {
      const preview = (section.content || '').slice(0, 80);
      return preview || <em style={{ color: '#94a3b8' }}>(empty)</em>;
    }
    // table
    const cols = (section.columns || []).length;
    const rows = (section.rows || []).length;
    return `${cols} column${cols !== 1 ? 's' : ''} × ${rows} row${rows !== 1 ? 's' : ''}`;
  }, [section]);

  const updateTitle = (e) => {
    const v = e.target.value.slice(0, TITLE_MAX);
    onUpdate({ title: v });
  };

  if (!editing) {
    return (
      <div
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 6,
          background: '#fff',
          padding: '0.625rem 0.875rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
        }}
      >
        <span aria-hidden="true" style={{ color: '#94a3b8' }}>
          {section.type === 'text' ? '📝' : '📊'}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--navy)' }}>
            {section.title || <em style={{ color: '#94a3b8', fontWeight: 400 }}>(untitled)</em>}
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--steel)', marginTop: '0.125rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {summary}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEdit}>Edit</button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onRemove}
          aria-label={`Delete ${section.title || 'section'}`}
          title="Delete section"
        >×</button>
      </div>
    );
  }

  return (
    <div
      style={{
        border: '1px solid #cbd5e1',
        borderRadius: 6,
        background: '#fff',
        padding: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
        <label htmlFor={titleId} style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>
          {section.type === 'text' ? '📝 Text' : '📊 Table'} title
        </label>
        <input
          id={titleId}
          className="form-input"
          value={section.title}
          onChange={updateTitle}
          placeholder={section.type === 'text' ? 'e.g., Daily Hindrances' : 'e.g., RMC Pour Record'}
          maxLength={TITLE_MAX}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCollapse}>
          Done
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onRemove}
          aria-label="Delete section"
          title="Delete section"
        >×</button>
      </div>

      {section.type === 'text' ? (
        <TextSectionEditor section={section} onUpdate={onUpdate} />
      ) : (
        <TableSectionEditor section={section} onUpdate={onUpdate} />
      )}
    </div>
  );
}

// Pulled out of CustomSectionCard to keep the file readable.
function TextSectionEditor({ section, onUpdate }) {
  const updateContent = (e) => {
    const v = e.target.value.slice(0, TEXT_MAX);
    onUpdate({ content: v });
  };
  const remaining = TEXT_MAX - (section.content || '').length;
  return (
    <div>
      <textarea
        className="form-input"
        rows={5}
        value={section.content || ''}
        onChange={updateContent}
        placeholder="Notes, observations, anything you want to attach to this section..."
        style={{ resize: 'vertical', minHeight: '100px' }}
      />
      <div style={{ fontSize: '0.7rem', color: 'var(--steel)', textAlign: 'right', marginTop: '0.25rem' }}>
        {remaining} characters left
      </div>
    </div>
  );
}

function TableSectionEditor({ section, onUpdate }) {
  const columns = Array.isArray(section.columns) ? section.columns : [];
  const rows = Array.isArray(section.rows) ? section.rows : [];

  const setColumns = (next) => {
    const trimmed = next.slice(0, COL_MAX).map((c) => String(c || '').slice(0, 60));
    // Re-shape rows to match new column count — preserve data on overlap, blank on extension.
    const nextRows = rows.map((r) => {
      const out = trimmed.map((_, i) => (r[i] != null ? String(r[i]).slice(0, CELL_MAX) : ''));
      return out;
    });
    onUpdate({ columns: trimmed, rows: nextRows });
  };

  const setColCount = (raw) => {
    const n = clamp(parseInt(raw, 10) || 1, 1, COL_MAX);
    const cur = columns.length;
    if (n === cur) return;
    if (n > cur) {
      const added = Array.from({ length: n - cur }, (_, i) => `Column ${cur + i + 1}`);
      setColumns([...columns, ...added]);
    } else {
      setColumns(columns.slice(0, n));
    }
  };

  const updateColumn = (idx, value) => {
    const next = columns.slice();
    next[idx] = value;
    setColumns(next);
  };

  const updateCell = (rowIdx, colIdx, value) => {
    const next = rows.map((r) => r.slice());
    next[rowIdx][colIdx] = String(value || '').slice(0, CELL_MAX);
    onUpdate({ rows: next });
  };

  const addRow = () => {
    if (rows.length >= ROW_MAX) return;
    onUpdate({ rows: [...rows, columns.map(() => '')] });
  };

  const removeRow = (idx) => {
    if (rows.length <= 1) {
      // Always keep at least one row so the grid stays editable.
      onUpdate({ rows: [columns.map(() => '')] });
      return;
    }
    onUpdate({ rows: rows.filter((_, i) => i !== idx) });
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <label style={{ fontSize: '0.8rem', color: 'var(--steel)' }}>Columns:</label>
        <select
          className="form-input"
          value={columns.length}
          onChange={(e) => setColCount(e.target.value)}
          style={{ width: 80 }}
          aria-label="Column count"
        >
          {Array.from({ length: COL_MAX }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary btn-sm" onClick={addRow} disabled={rows.length >= ROW_MAX}>
          + Row
        </button>
        <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginLeft: 'auto' }}>
          {rows.length} row{rows.length !== 1 ? 's' : ''} · max {ROW_MAX}
        </span>
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: 4 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ background: '#f1f5f9' }}>
              <th style={{ width: 32, padding: '0.375rem', borderBottom: '1px solid #e2e8f0' }} aria-label="Row number" />
              {columns.map((c, i) => (
                <th key={i} style={{ padding: '0.375rem', borderBottom: '1px solid #e2e8f0', textAlign: 'left' }}>
                  <input
                    className="form-input"
                    value={c}
                    onChange={(e) => updateColumn(i, e.target.value)}
                    placeholder={`Col ${i + 1}`}
                    maxLength={60}
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem', fontWeight: 600 }}
                  />
                </th>
              ))}
              <th style={{ width: 32, padding: '0.375rem', borderBottom: '1px solid #e2e8f0' }} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rIdx) => (
              <tr key={rIdx}>
                <td style={{ padding: '0.375rem', color: 'var(--steel)', textAlign: 'center', borderBottom: '1px solid #f1f5f9' }}>
                  {rIdx + 1}
                </td>
                {columns.map((_, cIdx) => (
                  <td key={cIdx} style={{ padding: '0.25rem', borderBottom: '1px solid #f1f5f9' }}>
                    <input
                      className="form-input"
                      value={row[cIdx] != null ? row[cIdx] : ''}
                      onChange={(e) => updateCell(rIdx, cIdx, e.target.value)}
                      maxLength={CELL_MAX}
                      placeholder=""
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
                    />
                  </td>
                ))}
                <td style={{ padding: '0.25rem', textAlign: 'center', borderBottom: '1px solid #f1f5f9' }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => removeRow(rIdx)}
                    aria-label={`Remove row ${rIdx + 1}`}
                    title="Remove row"
                  >×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
        Cell max {CELL_MAX} chars · column max {COL_MAX} · row max {ROW_MAX}
      </div>
    </div>
  );
}
