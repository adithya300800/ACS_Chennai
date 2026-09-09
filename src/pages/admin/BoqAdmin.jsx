// N7 (round-28) — admin BOQ registry.
//
// CRUD over BOQ items for one or more projects. The "variance" column on
// the right pulls the same numbers the standalone BoqVariance page does
// (backend route /api/boq/variance?projectName=…) and shows the live
// contract-vs-executed delta so admins can see overruns at a glance.
//
// The page is admin-only by virtue of where it's routed — `/portal/admin/*`
// is the sidebar's admin tree. The backend also enforces admin gates on
// the write endpoints (PATCH/DELETE require creator OR admin), so a
// stale JWT can't escalate via the wire.
//
// UX notes
// ────────
//   - Project filter is a free-text input (matches the existing DPR
//     projectName text box) — backend stores BOQ rows by free-text
//     projectName, not a foreign key, so a dropdown would need a
//     separate aggregate query. Keeping the input lets admins type a
//     name they're about to create rows for without round-tripping.
//   - Form opens in a full-screen modal on mobile (max-width expands to
//     viewport, scroll inside). Desktop uses the same 720px max as the
//     other modals (see src/components/Modal.jsx).
//   - amount = quantity × rate is computed live as the admin types.
//     The backend recomputes it on save and never trusts the client
//     value (see backend/src/routes/boq.js:249-253), but the local
//     preview keeps the form honest.
//   - Soft-delete confirmation: a delete flips `isActive` to false on
//     the server. The row stays so linked DPRs / Inspections keep their
//     FK reference intact.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import Modal from '../../components/Modal.jsx';
import Breadcrumb from '../../components/Breadcrumb.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';

const UNITS = ['cum', 'sqm', 'kg', 'nos', 'rm', 'mt'];

// Format an amount in INR. The BOQ lives in lakhs/crore territory for
// any real project, so locale formatting matters. Fall back to the raw
// number when the value isn't finite (empty form, NaN, etc.) so the
// cell never renders "₹NaN".
function formatInr(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  // Indian numbering: 1,23,45,678. Intl gives the closest equivalent.
  return n.toLocaleString('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  });
}

function formatVariancePct(executed, contract) {
  const c = Number(contract) || 0;
  const e = Number(executed) || 0;
  if (c <= 0) return '—';
  // Negative pct = under contract (good, more budget remaining).
  // Positive pct = over contract (bad, scope creep).
  const pct = ((e - c) / c) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

// ─── Form modal ───────────────────────────────────────────────────────────
// Single component, used for both create + edit. The shape of the form
// is identical between the two operations; `initial` carries the
// existing row (edit) or the default empty object (create).
function BoqFormModal({ open, initial, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    projectName: '',
    itemCode: '',
    description: '',
    unit: 'cum',
    quantity: '',
    rate: '',
    category: '',
    isActive: true,
    ...(initial || {}),
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isEdit = !!(initial && initial.id);

  // Reset whenever the modal is opened with a new target. Keeps the
  // form in sync with the row being edited.
  useEffect(() => {
    if (!open) return;
    setForm({
      projectName: '',
      itemCode: '',
      description: '',
      unit: 'cum',
      quantity: '',
      rate: '',
      category: '',
      isActive: true,
      ...(initial || {}),
    });
    setError('');
    setSaving(false);
  }, [open, initial]);

  const amount = useMemo(() => {
    const q = Number(form.quantity);
    const r = Number(form.rate);
    if (!Number.isFinite(q) || !Number.isFinite(r)) return 0;
    return q * r;
  }, [form.quantity, form.rate]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setError('');

    // Client-side guard rails that mirror backend validators in
    // boq.js. We send the wire contract even on guard-rail failure so
    // the toast shows the friendly text first; backend would refuse
    // anyway with a less helpful error.
    const trimmed = {
      projectName: (form.projectName || '').trim(),
      itemCode: (form.itemCode || '').trim(),
      description: (form.description || '').trim(),
      unit: (form.unit || '').trim(),
      category: form.category ? form.category.trim() : null,
      quantity: Number(form.quantity),
      rate: Number(form.rate),
    };
    if (!trimmed.projectName) return setError('Project name is required');
    if (!trimmed.itemCode) return setError('Item code is required');
    if (!trimmed.description) return setError('Description is required');
    if (!trimmed.unit) return setError('Unit is required');
    if (!Number.isFinite(trimmed.quantity) || trimmed.quantity < 0) {
      return setError('Quantity must be a non-negative number');
    }
    if (!Number.isFinite(trimmed.rate) || trimmed.rate < 0) {
      return setError('Rate must be a non-negative number');
    }

    setSaving(true);
    try {
      await onSave(trimmed);
      onClose();
    } catch (err) {
      // 409 from the backend means the (projectName, itemCode) pair
      // already exists. Surface it explicitly — the admin needs to
      // know the duplicate constraint, not a generic "failed".
      if (err?.code === 'DUPLICATE_BOQ_ITEM' || err?.status === 409) {
        setError('A BOQ item with this itemCode already exists for this project.');
      } else {
        setError(err?.message || 'Failed to save BOQ item');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      ariaLabel={isEdit ? 'Edit BOQ item' : 'Add BOQ item'}
      maxWidth={640}
    >
      <h2 style={{ margin: '0 0 1rem', color: 'var(--navy)', fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
        {isEdit ? 'Edit BOQ item' : 'Add BOQ item'}
      </h2>
      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <div className="form-group" style={{ flex: 2 }}>
            <label htmlFor="boq-projectName">Project Name *</label>
            <input
              id="boq-projectName"
              name="projectName"
              className="form-input"
              value={form.projectName}
              onChange={handleChange}
              placeholder="e.g. Metro Station Phase 2"
              required
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="boq-itemCode">Item Code *</label>
            <input
              id="boq-itemCode"
              name="itemCode"
              className="form-input"
              value={form.itemCode}
              onChange={handleChange}
              placeholder="2.3.1"
              required
            />
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="boq-description">Description *</label>
          <textarea
            id="boq-description"
            name="description"
            className="form-input"
            rows={2}
            value={form.description}
            onChange={handleChange}
            placeholder="e.g. RCC M25 slab casting for GF — Villa 4"
            required
            style={{ resize: 'vertical', minHeight: 60 }}
          />
        </div>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="boq-unit">Unit *</label>
            <select
              id="boq-unit"
              name="unit"
              className="form-input"
              value={form.unit}
              onChange={handleChange}
              required
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="boq-quantity">Quantity *</label>
            <input
              id="boq-quantity"
              name="quantity"
              type="number"
              min="0"
              step="0.01"
              className="form-input"
              value={form.quantity}
              onChange={handleChange}
              placeholder="0"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="boq-rate">Rate (INR) *</label>
            <input
              id="boq-rate"
              name="rate"
              type="number"
              min="0"
              step="0.01"
              className="form-input"
              value={form.rate}
              onChange={handleChange}
              placeholder="0"
              required
            />
          </div>
        </div>
        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="boq-category">Category (optional)</label>
            <input
              id="boq-category"
              name="category"
              className="form-input"
              value={form.category}
              onChange={handleChange}
              placeholder="e.g. Civil / Structural"
            />
          </div>
          <div className="form-group" style={{ alignSelf: 'flex-end' }}>
            <label htmlFor="boq-isActive" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                id="boq-isActive"
                name="isActive"
                type="checkbox"
                checked={!!form.isActive}
                onChange={handleChange}
              />
              Active
            </label>
          </div>
        </div>
        {/* Live amount preview. Server recomputes on save — this is just
            a UX hint so the admin sees "amount = 0" before they realise
            they cleared one of the inputs. */}
        <div
          style={{
            marginTop: '0.5rem',
            padding: '0.625rem 0.875rem',
            background: '#f8fafc',
            border: '1px solid #e2e8f0',
            borderRadius: 6,
            fontSize: '0.9rem',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ color: 'var(--steel)' }}>Computed amount</span>
          <strong style={{ color: 'var(--navy)' }}>{formatInr(amount)}</strong>
        </div>

        {error && (
          <div className="portal-auth-error" role="alert" style={{ marginTop: '0.75rem' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Create item')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Record-execution modal (DR-015) ────────────────────────────────────────
// The variance report's "executed quantity" is now summed from this
// ledger instead of the legacy DPR-quantity placeholder (see the
// backend /variance route header). One modal per item; admin only.
function RecordExecutionModal({ open, item, onClose, onSave }) {
  const [form, setForm] = useState({
    executedQuantity: '',
    stage: 'INSTALLED',
    accepted: true,
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm({ executedQuantity: '', stage: 'INSTALLED', accepted: true, notes: '' });
    setError('');
    setSaving(false);
  }, [open, item]);

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setForm((f) => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setError('');
    const qty = Number(form.executedQuantity);
    if (!Number.isFinite(qty) || qty < 0) {
      return setError('Executed quantity must be a non-negative number');
    }
    if (form.notes && form.notes.length > 1000) {
      return setError('Notes must be 1000 characters or fewer');
    }
    setSaving(true);
    try {
      await onSave({
        executedQuantity: qty,
        stage: form.stage,
        accepted: form.accepted,
        notes: form.notes ? form.notes.trim() : null,
      });
      onClose();
    } catch (err) {
      setError(err?.message || 'Failed to record execution');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} ariaLabel="Record BOQ execution" maxWidth={520}>
      <h2 style={{ margin: '0 0 0.25rem', color: 'var(--navy)' }}>Record execution</h2>
      <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
        <strong style={{ fontFamily: 'monospace' }}>{item?.itemCode}</strong> — {item?.description}
        {item && (
          <span style={{ marginLeft: '0.5rem', color: 'var(--steel)' }}>
            (contract qty: {Number(item.quantity).toLocaleString('en-IN', { maximumFractionDigits: 2 })} {item.unit})
          </span>
        )}
      </p>
      <form onSubmit={handleSubmit}>
        <div className="form-row">
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="exec-quantity">Executed quantity *</label>
            <input
              id="exec-quantity"
              name="executedQuantity"
              type="number"
              min="0"
              step="0.01"
              className="form-input"
              value={form.executedQuantity}
              onChange={handleChange}
              placeholder="0"
              required
            />
          </div>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="exec-stage">Stage</label>
            <select
              id="exec-stage"
              name="stage"
              className="form-input"
              value={form.stage}
              onChange={handleChange}
            >
              <option value="ISSUED">Issued to site</option>
              <option value="INSTALLED">Installed</option>
              <option value="PAID">Paid / certified</option>
            </select>
          </div>
        </div>
        <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            id="exec-accepted"
            name="accepted"
            type="checkbox"
            checked={!!form.accepted}
            onChange={handleChange}
          />
          <label htmlFor="exec-accepted" style={{ margin: 0, cursor: 'pointer' }}>
            Count toward variance (uncheck to record without billing)
          </label>
        </div>
        <div className="form-group">
          <label htmlFor="exec-notes">Notes (optional)</label>
          <textarea
            id="exec-notes"
            name="notes"
            className="form-input"
            rows={2}
            value={form.notes}
            onChange={handleChange}
            placeholder="e.g. Villa 4 GF slab, RAB-05 batch"
            style={{ resize: 'vertical', minHeight: 60 }}
          />
        </div>

        {error && (
          <div className="portal-auth-error" role="alert" style={{ marginTop: '0.75rem' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Recording…' : 'Record execution'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Confirm-delete dialog ─────────────────────────────────────────────────
function ConfirmDeleteModal({ open, item, onClose, onConfirm }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} ariaLabel="Confirm delete" maxWidth={420}>
      <h2 style={{ margin: '0 0 0.5rem', color: 'var(--navy)' }}>Delete BOQ item?</h2>
      <p style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: 'var(--steel)' }}>
        <strong>{item?.itemCode}</strong> — {item?.description}
      </p>
      <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--steel)' }}>
        Linked DPRs and Inspection Records keep their reference (soft-delete
        only — the row is hidden from this list but stays in the database
        for audit).
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          style={{ background: 'var(--danger)', color: 'white', border: 'none' }}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </Modal>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────
export default function BoqAdmin() {
  useDocumentTitle('BOQ Registry');
  const { accessToken } = useAuth();
  const toast = useToast();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  // [DR-022] Cursor-paginated load-more. The BOQ backend used to cap
  // the response at 100 rows with no `nextCursor` — a project with 101
  // BOQ lines had its 101st silently clipped. The backend now returns
  // `nextCursor`; we consume it via "Load more".
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [error, setError] = useState('');
  const [projectNameFilter, setProjectNameFilter] = useState('');
  // [N1 Phase B] Exact-match projectId filter — applied immediately on
  // selection change (no Apply button needed because the dropdown has
  // no typing delay). The legacy `appliedFilter` text input still drives
  // the projectName substring search + variance fetch so the two
  // surfaces remain independently useful.
  const [projectIdFilter, setProjectIdFilter] = useState('');
  // Apply button only triggers a refetch — the user can type the project
  // name first and only fire the network call when they're sure.
  const [appliedFilter, setAppliedFilter] = useState('');
  // [N1 Phase B] Registered projects for the dropdown. One-shot +
  // silent-on-failure — an empty dropdown just hides the new control.
  const [projects, setProjects] = useState([]);

  // Variance is fetched as a separate request so a stale item list
  // doesn't block the table render. Variance is project-scoped; we
  // only fetch it when a projectName is applied.
  const [varianceByItem, setVarianceByItem] = useState({});

  const [formOpen, setFormOpen] = useState(false);
  const [formInitial, setFormInitial] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  // DR-015: "Record execution" modal target. null = closed.
  const [executionTarget, setExecutionTarget] = useState(null);

  // Round-34 Feature 4: read ?projectId= from the URL so an admin
  // landing on the page from ProjectDashboard's "View all →" link
  // sees a project-scoped queue on first paint. Drops the manual
  // dropdown pick that previously broke the deep-link contract.
  //
  // ProjectDashboard forwards either a UUID (registered project) or
  // "name:<text>" (discovered project). BOQ accepts both shapes —
  // the UUID slot is `projectId`, the bare-name slot is `projectName`
  // text. We mirror accordingly so the deep-link Just Works for both
  // kinds.
  const [searchParams] = useSearchParams();
  const urlProjectId = searchParams.get('projectId') || '';
  // DR-013: consume ?focus=<id> from ProjectDashboard drill so the BOQ
  // queue scrolls to + highlights the row the admin just clicked.
  const urlFocus = searchParams.get('focus') || '';
  const [urlSeeded, setUrlSeeded] = useState(false);
  useEffect(() => {
    if (urlSeeded || !urlProjectId) return;
    if (urlProjectId.startsWith('name:')) {
      // Discovered project — only `projectName` text matches.
      const name = urlProjectId.slice(5);
      setAppliedFilter(name);
    } else {
      setProjectIdFilter(urlProjectId);
      setAppliedFilter(urlProjectId);
    }
    setUrlSeeded(true);
  }, [urlProjectId, urlSeeded]);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { isActive: 'true', limit: '100' };
      if (appliedFilter) params.projectName = appliedFilter;
      // [N1 Phase B] projectId exact-match filter. Backend (boq.js:190-194)
      // honours it as `where.projectId` so the dropdown acts as a quick
      // switch to one site's bill-of-quantities. Independent of the
      // projectName substring search above.
      if (projectIdFilter) params.projectId = projectIdFilter;
      const data = await api.getBoqItems(params, accessToken);
      setItems(data.items || []);
      // [DR-022] Honour the server's `nextCursor`; "Load more" walks it.
      setNextCursor(data?.nextCursor || null);
      setHasMore(!!data?.nextCursor);
    } catch (err) {
      setError(err.message || 'Failed to load BOQ items');
    } finally {
      setLoading(false);
    }
  }, [accessToken, appliedFilter, projectIdFilter]);

  // [DR-022] Load-more cursor walk. One round trip per click; stops
  // when the server's nextCursor is null.
  const loadMoreItems = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = { isActive: 'true', limit: '100', cursor: nextCursor };
      if (appliedFilter) params.projectName = appliedFilter;
      if (projectIdFilter) params.projectId = projectIdFilter;
      const data = await api.getBoqItems(params, accessToken);
      setItems((prev) => [...prev, ...(data.items || [])]);
      setNextCursor(data?.nextCursor || null);
      setHasMore(!!data?.nextCursor);
    } catch (err) {
      toast.push(err.message || 'Failed to load more BOQ items.', 'error');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, appliedFilter, projectIdFilter, accessToken, toast]);

  // Variance only matters for projects — we fetch it when the user has
  // applied a project filter so the variance column can show real
  // numbers instead of em-dashes. When the filter is empty we skip the
  // call entirely (it would 400 without projectName anyway).
  const fetchVariance = useCallback(async () => {
    if (!appliedFilter) {
      setVarianceByItem({});
      return;
    }
    try {
      const data = await api.getBoqVariance(appliedFilter, accessToken);
      const map = {};
      (data.items || []).forEach((v) => {
        map[v.id] = v;
      });
      setVarianceByItem(map);
    } catch {
      // Variance is decorative on this page — silently clear so we
      // don't block the table render on a transient failure.
      setVarianceByItem({});
    }
  }, [accessToken, appliedFilter, projectIdFilter]);

  // [N1 Phase B] One-shot project list fetch. Backend (boq.js) doesn't
  // gate /projects on isAdmin, so admins get the same set the rest of
  // the portal sees. Capped to limit=200 so the dropdown stays scannable.
  useEffect(() => {
    let cancelled = false;
    api.getProjects({ isActive: 'true', limit: '200' }, accessToken)
      .then((data) => { if (!cancelled) setProjects(data.projects || []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [accessToken]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    fetchVariance();
  }, [fetchVariance]);

  const openCreate = () => {
    setFormInitial(null);
    setFormOpen(true);
  };

  const openEdit = (item) => {
    setFormInitial({
      ...item,
      // quantity / rate may be numbers or strings from the server —
      // normalise to strings so the <input> stays controlled.
      quantity: item.quantity != null ? String(item.quantity) : '',
      rate: item.rate != null ? String(item.rate) : '',
    });
    setFormOpen(true);
  };

  const handleSave = async (payload) => {
    if (formInitial && formInitial.id) {
      await api.updateBoqItem(formInitial.id, payload, accessToken);
      toast.push('BOQ item updated.', 'success');
    } else {
      await api.createBoqItem(payload, accessToken);
      toast.push('BOQ item created.', 'success');
    }
    await fetchItems();
    await fetchVariance();
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    await api.softDeleteBoqItem(confirmDelete.id, accessToken);
    toast.push('BOQ item deleted.', 'success');
    await fetchItems();
    await fetchVariance();
  };

  // DR-015: handler for the Record-execution modal. The new execution
  // row contributes to the variance sum on the next refetch; we
  // refetch the variance map immediately so the row's badge updates
  // without a manual reload.
  const handleRecordExecution = async (payload) => {
    if (!executionTarget) return;
    await api.recordBoqExecution(executionTarget.id, payload, accessToken);
    toast.push('Execution recorded.', 'success');
    await fetchVariance();
  };

  return (
    <div className="dpr-page">
      <div className="dpr-page-header">
        <div>
          <Breadcrumb
            items={[
              { label: 'Admin Overview', to: '/portal/admin' },
              { label: 'BOQ Registry' },
            ]}
          />
          <h1 className="dpr-page-title">BOQ Registry</h1>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/portal/boq" className="btn btn-secondary btn-sm">
            View variance report →
          </Link>
          <button className="btn btn-primary" onClick={openCreate}>
            + Add BOQ item
          </button>
        </div>
      </div>

      {/* Toolbar: projectName filter. Same visual contract as the DPR
          filter row — input + Apply button + a clear pill. */}
      <div className="dpr-card" style={{ marginBottom: '1rem' }}>
        <div className="form-row" style={{ alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label htmlFor="boq-filter-project">Filter by project</label>
            <input
              id="boq-filter-project"
              type="text"
              className="form-input"
              value={projectNameFilter}
              onChange={(e) => setProjectNameFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setAppliedFilter(projectNameFilter.trim());
              }}
              placeholder="e.g. Metro Station Phase 2"
            />
          </div>
          <div className="form-group" style={{ alignSelf: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setAppliedFilter(projectNameFilter.trim())}
            >
              Apply
            </button>
          </div>
          {appliedFilter && (
            <div className="form-group" style={{ alignSelf: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setProjectNameFilter('');
                  setAppliedFilter('');
                }}
              >
                Clear
              </button>
            </div>
          )}
        </div>
        {/* [N1 Phase B] Second filter row — exact-match projectId dropdown.
            Lives on its own row so the toolbar doesn't wrap awkwardly on
            narrow admin viewports; auto-applies on selection so the user
            sees results without an extra Apply click. */}
        <div className="form-row" style={{ marginTop: '0.5rem' }}>
          <div className="form-group" style={{ minWidth: 240 }}>
            <label htmlFor="boq-filter-projectId">Or pick a registered project</label>
            <select
              id="boq-filter-projectId"
              className="form-input"
              value={projectIdFilter}
              onChange={(e) => setProjectIdFilter(e.target.value)}
              disabled={projects.length === 0}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.code ? ` (${p.code})` : ''}
                </option>
              ))}
            </select>
          </div>
          {projectIdFilter && (
            <div className="form-group" style={{ alignSelf: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setProjectIdFilter('')}
              >
                Clear project
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--steel)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⏳</div>
          Loading BOQ items...
        </div>
      ) : items.length === 0 ? (
        <div className="dpr-list-empty">
          <div style={{ marginBottom: '1rem', color: 'var(--steel)', fontSize: '2rem' }}>📋</div>
          <h3 style={{ color: 'var(--navy)', marginBottom: '0.5rem' }}>No BOQ items yet</h3>
          <p style={{ color: 'var(--steel)', marginBottom: '1.5rem' }}>
            {appliedFilter
              ? `No items match project "${appliedFilter}".`
              : 'Create your first BOQ item to start linking DPR and Inspection rows to a bill-of-quantities.'}
          </p>
          <button className="btn btn-primary" onClick={openCreate}>
            + Add BOQ item
          </button>
        </div>
      ) : (
        <div className="dpr-card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* Header row mirrors DprList/InspectionList. Variance column
              is only present when a project filter is applied — it would
              always be "—" otherwise. */}
          <div
            className="dpr-list-item"
            style={{
              background: '#f8fafc',
              fontWeight: 600,
              fontSize: '0.8rem',
              color: 'var(--steel)',
              padding: '0.75rem 1rem',
              display: 'flex',
            }}
          >
            <div style={{ flex: '0 0 110px' }}>Code</div>
            <div style={{ flex: 2 }}>Description</div>
            <div style={{ flex: '0 0 80px' }}>Unit</div>
            <div style={{ flex: '0 0 110px', textAlign: 'right' }}>Qty</div>
            <div style={{ flex: '0 0 130px', textAlign: 'right' }}>Rate (INR)</div>
            <div style={{ flex: '0 0 140px', textAlign: 'right' }}>Amount</div>
            {appliedFilter && (
              <div style={{ flex: '0 0 130px', textAlign: 'right' }}>Variance</div>
            )}
            <div style={{ flex: '0 0 120px', textAlign: 'right' }}>Actions</div>
          </div>

          {items.map((item) => {
            const v = varianceByItem[item.id];
            // DR-013: focus highlight when the URL carries ?focus=<id>
            // from the ProjectDashboard drill.
            const isFocused = urlFocus && item.id === urlFocus;
            return (
              <div
                key={item.id}
                ref={isFocused ? (el) => { if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } : undefined}
                className="dpr-list-item"
                style={isFocused
                  ? { display: 'flex', boxShadow: '0 0 0 3px rgba(0,102,255,0.45)', borderColor: 'var(--blue, #0066FF)' }
                  : { display: 'flex' }}
              >
                <div style={{ flex: '0 0 110px', fontFamily: 'monospace', color: 'var(--navy)' }}>
                  {item.itemCode}
                </div>
                <div style={{ flex: 2, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, color: 'var(--navy)', marginBottom: '0.25rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.description}
                  </div>
                  {item.category && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--steel)' }}>
                      {item.category}
                    </div>
                  )}
                </div>
                <div style={{ flex: '0 0 80px', fontSize: '0.85rem', color: 'var(--steel)' }}>
                  {item.unit}
                </div>
                <div style={{ flex: '0 0 110px', textAlign: 'right', fontSize: '0.85rem' }}>
                  {Number(item.quantity).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                </div>
                <div style={{ flex: '0 0 130px', textAlign: 'right', fontSize: '0.85rem' }}>
                  {formatInr(item.rate)}
                </div>
                <div style={{ flex: '0 0 140px', textAlign: 'right', fontWeight: 600, color: 'var(--navy)' }}>
                  {formatInr(item.amount)}
                </div>
                {appliedFilter && (
                  <div
                    style={{
                      flex: '0 0 130px',
                      textAlign: 'right',
                      fontSize: '0.85rem',
                      // Color-coded: green for ahead (negative variance),
                      // red for overrun. Same semantic as BoqVariance.
                      color: v ? (v.varianceQty < 0 ? '#dc2626' : v.varianceQty > 0 ? '#16a34a' : 'var(--steel)') : 'var(--steel)',
                    }}
                    title={v ? `Executed ${v.executedQty} of ${v.contractQty} ${item.unit}` : undefined}
                  >
                    {v ? formatVariancePct(v.executedQty, v.contractQty) : '—'}
                  </div>
                )}
                <div style={{ flex: '0 0 120px', textAlign: 'right', display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => openEdit(item)}
                    aria-label={`Edit BOQ item ${item.itemCode}`}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ color: '#16a34a' }}
                    onClick={() => setExecutionTarget(item)}
                    aria-label={`Record BOQ execution for ${item.itemCode}`}
                    title={`Executed ${v ? Number(v.executedQty || 0).toLocaleString('en-IN') : 0} of ${Number(item.quantity).toLocaleString('en-IN')} ${item.unit}`}
                  >
                    Record exec
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'var(--danger)' }}
                    onClick={() => setConfirmDelete(item)}
                    aria-label={`Delete BOQ item ${item.itemCode}`}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ textAlign: 'center', color: 'var(--steel)', fontSize: '0.8rem', padding: '0.5rem' }}>
        Showing {items.length} BOQ item{items.length !== 1 ? 's' : ''}
        {appliedFilter && ` for project "${appliedFilter}"`}
      </div>

      <BoqFormModal
        open={formOpen}
        initial={formInitial}
        onClose={() => setFormOpen(false)}
        onSave={handleSave}
      />
      <ConfirmDeleteModal
        open={!!confirmDelete}
        item={confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
      />
      <RecordExecutionModal
        open={!!executionTarget}
        item={executionTarget}
        onClose={() => setExecutionTarget(null)}
        onSave={handleRecordExecution}
      />
    </div>
  );
}
