import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob } from '../../lib/blobUpload.js';
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_DPR, ACCEPTED_PHOTO_TYPES } from '../../lib/constants.js';
import DprCustomSection from './DprCustomSection.jsx';
import FormProgress from '../../components/FormProgress.jsx';
import DrawingPicker from '../../components/DrawingPicker.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { formatShortDate } from '../../lib/format.js';
import {
  load as loadScopedDraft,
  save as saveScopedDraft,
  clear as clearScopedDraft,
} from '../../lib/ownerScopedDraft.js';

const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rainy', 'Windy', 'Haze', 'Foggy'];
// SOL-P2 #11: structured workforce row builder. The Manpower field used
// to be a free-text textarea where engineers typed things like
// "Mason — 6 nos — 8 hrs | Helper — 4 nos — 8 hrs". That's fragile to
// aggregate in reports. The new UI gives each trade its own row, but
// keeps the same pipe-separated on-the-wire format so no DB migration
// is needed. `parseManpowerSummary` splits a stored value into rows;
// `serializeManpowerRows` is the inverse for submit and draft save.
//
// Format on the wire: "Trade — Count — Hours" joined by " | ". Each
// row segment uses an em dash (U+2014) which is what the previous
// placeholder guidance already used, so legacy values parse cleanly.
const MAX_MANPOWER_ROWS = 10;
const parseManpowerSummary = (str) => {
  if (!str || typeof str !== 'string') return [{ trade: '', count: '', hours: '' }];
  return str
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((segment) => {
      const parts = segment.split('—').map((p) => p.trim());
      if (parts.length >= 3) {
        return { trade: parts[0], count: parts[1], hours: parts[2] };
      }
      // Fallback: legacy free-text — keep the whole string as the trade
      // field so the engineer can see + edit what was originally typed.
      return { trade: segment, count: '', hours: '' };
    });
};
const serializeManpowerRows = (rows) =>
  rows
    .filter((r) => r && r.trade && String(r.trade).trim().length > 0)
    .map((r) => `${String(r.trade).trim()} — ${r.count || ''} — ${r.hours || ''}`)
    .join(' | ');
// SOL DR-003 — owner-scoped keys. The previous unscoped `dpr_draft_v1` kept
// the previous account's draft on a shared computer. See ownerScopedDraft.js
// for the migration / clearing contract.
const DRAFT_BASE = 'dpr_draft_v1';

const getLocalDate = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now - offset * 60000);
  return local.toISOString().split('T')[0];
};

const validateReportDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return 'Report date must be in YYYY-MM-DD format. Please refresh the page.';
  }
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (new Date(value) > today) return 'Report date cannot be in the future.';
  return null;
};

// SOL DR-004: when editing an existing draft the server may send
// `reportDate` as either a strict YYYY-MM-DD string (post-fix) or a raw
// JS Date that JSON.stringify renders as ISO datetime (pre-fix). Either
// form is reduced to YYYY-MM-DD for the date input, falling back to the
// local "today" string when the value is missing/invalid so the form
// still mounts cleanly.
function normalizeReportDate(value) {
  if (!value) return getLocalDate();
  if (typeof value === 'string') {
    // Already a date-only string.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  // Date instance or any other Date-coercible input.
  const d = new Date(value);
  if (isNaN(d.getTime())) return getLocalDate();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Round-12: DPR's `workType` is now a category tag, not a derived value.
// All 15 sub-work-types moved to Inspection & Compliance Records, so the
// DPR's workType just needs to classify the day's narrative. Keep the
// backend's required-allowlist intact.
const WORK_TYPE_OPTIONS = [
  { value: 'MATERIAL_RECEIPT', label: 'Material Receipt' },
  { value: 'QUALITY_TESTING', label: 'Quality / Testing' },
  { value: 'SITE_INSPECTION', label: 'Site Inspection' },
  { value: 'EXCEPTIONS_SAFETY', label: 'Exceptions / Safety' },
];

// A-11: section skip-nav anchors. Keep in sync with the <section id>
// attributes below — used by the sticky in-form nav at the top of the page.
const DPR_SECTIONS = [
  { id: 'dpr-section-site', label: 'Site Info' },
  { id: 'dpr-section-narrative', label: 'Daily Narrative' },
  { id: 'dpr-section-photos', label: 'Photos' },
  { id: 'dpr-section-custom', label: 'Custom Sections' },
  { id: 'dpr-section-inspections', label: "Today's Inspections" },
];

function loadDraft() {
  // Back-compat shim — module-level callers still pass through `currentEmployeeId`
  // via the wrappers below. Kept as a no-op default so legacy references do
  // not silently introduce unscoped access.
  return null;
}

function saveDraft(payload) {
  // Back-compat shim — see loadDraft above.
  return null;
}

function clearDraft() {
  // Back-compat shim — see loadDraft above.
  return null;
}

function loadDraftForEmployee(currentEmployeeId) {
  return loadScopedDraft(DRAFT_BASE, currentEmployeeId);
}

function saveDraftForEmployee(currentEmployeeId, payload) {
  if (!currentEmployeeId) return;
  saveScopedDraft(DRAFT_BASE, currentEmployeeId, {
    form: payload.form,
    dailyFields: payload.dailyFields,
    notes: payload.notes,
    customSections: payload.customSections,
    photos: (payload.photos || []).map((p) => ({
      ulid: p.ulid,
      container: p.container,
      filename: p.filename,
      contentType: p.contentType,
      sizeBytes: p.sizeBytes,
      caption: p.caption,
      location: p.location,
      takenAt: p.takenAt,
      // SOL DR-006: preserve the SAS readUrl when the photo was
      // rehydrated from a server-side draft. New uploads from the
      // editor won't have this field; the serializer just passes it
      // through if present so the next mount (after a reload) can
      // render the preview without refetching.
      ...(p.readUrl ? { readUrl: p.readUrl } : {}),
    })),
  });
}

function clearDraftForEmployee(currentEmployeeId) {
  if (!currentEmployeeId) return;
  clearScopedDraft(DRAFT_BASE, currentEmployeeId);
}

function formatIndianDate(iso) {
  if (!iso) return '—';
  const out = formatShortDate(iso);
  return out || String(iso);
}


export default function DprSubmit() {
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const draftId = searchParams.get('draftId') || null;
  // SOL-P1 mobile: order matters — draftId must be declared before
  // useDocumentTitle's first call so the minifier doesn't trip the TDZ
  // ("Cannot access 'g' before initialization") when the document-title
  // effect tries to read it on mount.
  useDocumentTitle(draftId ? 'Edit Draft · Daily Progress Report' : 'New Daily Progress Report');
  const fileInputRef = useRef(null);
  const submittingRef = useRef(false);

  // SOL DR-003 — owner-scoped draft. The previous unscoped `dpr_draft_v1`
  // leaked prior accounts' drafts onto shared computers. See
  // ownerScopedDraft.js for the migration contract.
  const currentEmployeeId = employee?.id ?? null;
  const initialDraft = loadDraftForEmployee(currentEmployeeId);
  const [form, setForm] = useState(initialDraft?.form || {
    // [N1 Phase B] projectId drives the new project picker; projectName
    // is the denormalized canonical name we keep sending on the wire
    // for legacy compatibility (the backend still requires it alongside
    // the new projectId field). When the user picks a project from the
    // dropdown, we set BOTH atomically in handleProjectChange so the
    // two never drift.
    projectId: '',
    projectName: '',
    location: '',
    reportDate: getLocalDate(),
    // BUG-2 (round-37): was 'Sunny' — silently biased the dataset so the
    // vast majority of historical DPRs report Sunny regardless of site.
    // Engineers now have to pick weather (or confirm Sunny) themselves.
    weather: '',
    temperature: '',
    contractor: '',
    workType: 'SITE_INSPECTION',
    // N7: optional link to a Bill-of-Quantities item. Backend treats
    // null/missing as "no link" so the field never breaks existing
    // submissions.
    boqItemId: '',
    // N3 (Phase F): optional drawing stamp. drawingRev is denormalized
    // from the selected drawing row at submit time so the wire record
    // survives even if the drawing is later superseded or renamed.
    drawingId: '',
    drawingRev: '',
  });
  // [N1 Phase B] project picker data — same payload the admin
  // ProjectsAdmin page uses (registered + auto-discovered). We merge
  // them into one list keyed by name (the dropdown's value is the
  // project UUID for registered rows, or the literal name string for
  // discovered rows). The selected option's `name` is what we send as
  // `projectName` to the backend.
  const [projects, setProjects] = useState([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  // [R34] Inline create-new-project flow. Same shape as DrawingsBrowse
  // (Round-32): pick the `__create__` sentinel → name input + Create
  // button → calls api.resolveProject → merges the new Project into
  // the picker and selects it. Replaces the previous "submit a DPR and
  // hope the backend auto-creates" round-trip with a visible affordance.
  const [createMode, setCreateMode] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [resolveError, setResolveError] = useState('');
  // [Bug fix] True while POST /api/projects/resolve is in flight after
  // the user picks a discovered (name-only) project row. Disables the
  // picker + shows a "Registering…" hint so the user can't double-click
  // into a second resolve or stale-state race.
  const [resolvingProject, setResolvingProject] = useState(false);
  // N7: BOQ items for the current projectName, loaded when the project
  // is named. We don't fetch on every keystroke — only when the user
  // has finished typing a project name and either blurred the field
  // OR explicitly cleared it. The selector renders "No BOQ items" if
  // the list is empty for the named project, with an "Open BOQ
  // Registry" link for admins.
  const [boqItems, setBoqItems] = useState([]);
  const [boqItemsLoaded, setBoqItemsLoaded] = useState(false);
  // Round-12: 5 daily-narrative fields every site engineer records at end
  // of day. Backend caps match the route validator.
  const [dailyFields, setDailyFields] = useState(initialDraft?.dailyFields || {
    workExecutedToday: '',
    workLocation: '',
    manpowerSummary: '',
    risksHindrances: '',
    materialsReceivedSummary: '',
  });
  // SOL-P2 #11: structured workforce rows, derived from the existing
  // pipe-separated manpowerSummary string. The textarea is gone — see
  // the row-builder UI below. We keep `manpowerSummary` on `dailyFields`
  // for backend compatibility (it gets re-serialized on submit/draft).
  const [manpowerRows, setManpowerRows] = useState(() =>
    parseManpowerSummary(dailyFields.manpowerSummary)
  );
  // SOL-P2 #11: keep the legacy `dailyFields.manpowerSummary` string in
  // sync with the structured rows so every downstream consumer (draft
  // save, validity check, draft-restore banner, edit-mode bootstrap)
  // sees the latest value without each call site having to know about
  // the row shape.
  useEffect(() => {
    const serialized = serializeManpowerRows(manpowerRows);
    setDailyFields((f) => (f.manpowerSummary === serialized ? f : { ...f, manpowerSummary: serialized }));
  }, [manpowerRows]);
  const [customSections, setCustomSections] = useState(initialDraft?.customSections || []);
  // SOL DR-005: seed photos from the local-draft envelope so the 750ms
  // autosave that fires on first render cannot write `photos: []` over a
  // previously-saved list and silently drop recoverable claims. Same
  // malformed/quarantine guard the form-state initializer uses — a
  // quarantined legacy draft is left empty (banner handles it). The
  // serializer (saveDraftForEmployee above) keeps only durable fields
  // (ulid/container/filename/caption/readUrl) and drops blob URLs, so
  // what's loaded back is safe to render with previewUrl || readUrl.
  const [photos, setPhotos] = useState(() => {
    if (initialDraft?.__malformed || initialDraft?.__quarantined || !initialDraft) return [];
    return Array.isArray(initialDraft.photos) ? initialDraft.photos : [];
  });
  const [notes, setNotes] = useState(initialDraft?.notes || '');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  // SOL DR-006: if `loadDraftForEmployee` returned a quarantine sentinel
  // (`__quarantined: true`), do NOT pre-fill the form. Show a banner
  // instead and let the engineer discard the orphan value. The state
  // initializers below mirror the malformed-draft pattern in
  // InspectionSubmit.jsx so the banner survives later re-renders.
  const initialQuarantinedReason = initialDraft?.__quarantined ? initialDraft.reason : null;
  const [showDraftBanner, setShowDraftBanner] = useState(
    !!initialDraft && !initialDraft.__quarantined,
  );
  const [quarantinedReason] = useState(initialQuarantinedReason);
  // On mount, drop the quarantined legacy value from localStorage so the
  // next load does not re-surface the banner. Mirrors the malformed-
  // legacy cleanup in InspectionSubmit.jsx.
  useEffect(() => {
    if (quarantinedReason && currentEmployeeId) clearDraftForEmployee(currentEmployeeId);
  }, [quarantinedReason, currentEmployeeId]);
  const [uploadStatuses, setUploadStatuses] = useState({});
  const [todayInspections, setTodayInspections] = useState([]);
  const [todayInspectionsLoaded, setTodayInspectionsLoaded] = useState(false);
  const photoObjectUrlsRef = useRef(new Set());

  // [DR-006 client] Live count of photos still going through the SAS / PUT
  // / confirm-upload pipeline. Submit is blocked while this is > 0 so a
  // report can never be created referencing an upload that hasn't reached
  // CONFIRMED yet. Re-evaluated on every render — cheap because uploadStatuses
  // is small and most entries settle to 'complete' / 'error' quickly.
  const hasInFlightUploads = useMemo(
    () => Object.values(uploadStatuses).some(
      (s) => s && (s.status === 'requesting-sas' || s.status === 'uploading' || s.status === 'confirming'),
    ),
    [uploadStatuses],
  );

  // SOL-P0#4: when arriving via ?draftId=…, load the server-side draft and
  // pre-populate the form. The submit handler switches to PUT /:id instead
  // of POST / when editingId is set. The local-autosave banner is suppressed
  // so we don't show "Restored unsaved draft" alongside an explicit server
  // draft load.
  const [editingId, setEditingId] = useState(null);
  const [editingVersion, setEditingVersion] = useState(null);
  const [draftLoadedFromServer, setDraftLoadedFromServer] = useState(false);
  // SOL DR-006: defense-in-depth guard against the hydration effect
  // re-running when only its context deps change (toast push, token
  // rotation). The audit pinpointed ToastContext.jsx:21-64 — the value
  // object was un-memoized so every push invalidated the value identity
  // and re-ran this effect. We've since memoized that value, but this
  // ref still lets us skip a redundant GET when the user revisits the
  // same draftId (or when auth context rotates the access token after
  // the initial load already succeeded).
  //
  // The second ref is a monotonically-incrementing run id. The cleanup
  // runs on every effect call (toast push, token rotate, unmount alike),
  // and a naive `cancelled` flag would abort the in-flight hydration
  // before it can apply state. By stamping each hydration with a run id
  // and only applying state when the latest run still matches, we let
  // the in-flight fetch complete cleanly while still allowing a future
  // draftId change to supersede it.
  const lastHydratedDraftIdRef = useRef(null);
  const hydrationRunIdRef = useRef(0);
  // SOL DR-003: tracks the server-acknowledged version returned by the most
  // recent successful PUT within this component lifetime. On a Submit retry
  // (the user clicks Submit Report again after a prior attempt PUT'd but
  // the publish call failed or its response was lost) we MUST NOT re-PUT —
  // photo additions are already persisted on the server and a second PUT
  // would either double-create them or waste a version increment. The ref
  // is reset when a fresh draft is hydrated so a stale value from a
  // previous draft can't leak across Resume sessions.
  const lastPutVersionRef = useRef(null);

  useEffect(() => {
    if (!draftId || !accessToken) return;
    if (lastHydratedDraftIdRef.current === draftId) return;
    // Mark synchronously so a sibling re-render that re-runs this
    // effect short-circuits at the ref guard above. We stamp with a
    // monotonically-incrementing run id and only apply state when the
    // latest run still matches — so a re-run for the same draftId is
    // a true no-op (the closure's await still completes but its
    // results are discarded), while a future draftId change cleanly
    // supersedes the in-flight one.
    lastHydratedDraftIdRef.current = draftId;
    const myRunId = ++hydrationRunIdRef.current;
    (async () => {
      try {
        const d = await api.getDpr(draftId, accessToken);
        if (hydrationRunIdRef.current !== myRunId) return;
        if (d.status !== 'DRAFT') {
          toast.push(`This report is no longer a draft (status: ${d.status}).`, 'warning');
          navigate('/portal/dpr/my', { replace: true });
          lastHydratedDraftIdRef.current = null;
          return;
        }
        setEditingId(d.id);
        setEditingVersion(d.version);
        // SOL DR-003: a fresh draft load clears any stale acknowledged
        // version from a prior session — otherwise a retry's GET would
        // pick up the old ref'd value instead of the just-loaded version.
        lastPutVersionRef.current = null;
        setForm({
          // [N1 Phase B] projectId is denormalized on the DPR row going
          // forward; legacy rows may have it null. When the server
          // includes a `project` relation we use its id; otherwise we
          // fall back to '' and the form renders the free-text name
          // (the user can re-pick from the dropdown to attach a real
          // projectId).
          projectId: d.projectId || (d.project && d.project.id) || '',
          projectName: d.projectName || '',
          location: d.location || '',
          // SOL DR-004: backend now emits strict YYYY-MM-DD (see
          // backend/src/routes/dpr.js:1063 normalization). If a pre-fix
          // server still returns an ISO datetime, strip the time suffix
          // so the date input keeps its value.
          reportDate: normalizeReportDate(d.reportDate),
          // BUG-2 (round-37): preserve server value verbatim (including
          // legacy rows the engineer picked 'Sunny' on) but do NOT
          // synthesize a 'Sunny' default when the field is empty.
          weather: d.weather || '',
          temperature: d.temperature || '',
          contractor: d.contractor || '',
          workType: d.workType || 'SITE_INSPECTION',
          // N7: preserve linked BOQ item across draft resume.
          boqItemId: d.boqItemId || '',
          // N3 (Phase F): preserve linked drawing across draft resume.
          // drawingRev is denormalized server-side so we read it from
          // the response rather than refetching the drawing.
          drawingId: d.drawingId || '',
          drawingRev: d.drawingRev || '',
        });
        setDailyFields({
          workExecutedToday: d.workExecutedToday || '',
          workLocation: d.workLocation || '',
          manpowerSummary: d.manpowerSummary || '',
          risksHindrances: d.risksHindrances || '',
          materialsReceivedSummary: d.materialsReceivedSummary || '',
        });
        setCustomSections(Array.isArray(d.customSections) ? d.customSections : []);
        setNotes(d.notes || '');
        // SOL-P2 #11: reparse the structured workforce rows from the
        // just-loaded `manpowerSummary` string. The useState initializer
        // already ran with the *empty* initial value, so this effect
        // runs the parser again now that the real data is here.
        setManpowerRows(parseManpowerSummary(d.manpowerSummary || ''));
        // SOL DR-006: photo state previously initialized empty after
        // the server load which dropped previously-attached evidence on
        // every resume and let the next typed-in photo be silently lost.
        // Server-side photos are read-only references (SAS URLs we can't
        // re-upload through), but their ULID + container survive into
        // the next PUT. We keep `readUrl` on the row so the renderer can
        // show a preview even without a local blob.
        //
        // SOL DR-004: mark server-loaded photos `persisted: true` so the
        // Submit handler only sends NEW additions. Without this flag
        // every Save would re-send the already-persisted photos and
        // (before the server-side dedupe landed) the server's nested
        // `photos: { create: [...] }` happily duplicated each one. The
        // flag is the additive semantic the audit asked for: persisted
        // rows are owned by the server, additions are owned by the
        // client, and the two never collide.
        const serverPhotos = Array.isArray(d.photos) ? d.photos : [];
        setPhotos(serverPhotos.map((p) => ({
          ulid: p.ulid,
          container: p.container,
          filename: p.filename,
          contentType: p.contentType,
          sizeBytes: p.sizeBytes,
          caption: p.caption || null,
          location: p.location || null,
          takenAt: p.takenAt || null,
          readUrl: p.readUrl || null,
          persisted: true,
        })));
        setShowDraftBanner(false); // suppress local-autosave banner
        setDraftLoadedFromServer(true);
      } catch (err) {
        if (hydrationRunIdRef.current !== myRunId) return;
        toast.push(err.message || 'Failed to load draft', 'error');
        // Reset so a transient failure can be retried by navigating
        // away + back (or by a future deps change).
        lastHydratedDraftIdRef.current = null;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, accessToken, toast, navigate]);

  // Persist draft on every meaningful change. 750ms debounce matches the
  // pre-Round-12 behaviour at the original DprSubmit.jsx:124.
  useEffect(() => {
    if (!currentEmployeeId) return;
    const t = setTimeout(
      () => saveDraftForEmployee(currentEmployeeId, { form, dailyFields, notes, customSections, photos }),
      750
    );
    return () => clearTimeout(t);
  }, [form, dailyFields, notes, customSections, photos, currentEmployeeId]);

  // Revoke any blob URLs we created when the component unmounts.
  useEffect(() => {
    return () => {
      photoObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      photoObjectUrlsRef.current.clear();
    };
  }, []);

  // SOL DR-003 — listen for the logout fan-out. AuthContext dispatches
  // `draft:clear-current` with `{ employeeId }` whenever the local session
  // ends (manual logout, 401, preemptive refresh fail). We wipe the in-memory
  // form so the next user on a shared machine starts clean even if React
  // doesn't unmount this component in time. The localStorage key itself is
  // already gone — AuthContext runs `clearScopedDraft` directly.
  useEffect(() => {
    const handler = (e) => {
      if (e.detail?.employeeId && e.detail.employeeId !== currentEmployeeId) return;
      setForm({
        // [N1 Phase B] reset both projectId + projectName in lockstep.
        projectId: '',
        projectName: '',
        location: '',
        reportDate: getLocalDate(),
        // BUG-2 (round-37): empty default; see comment at line 201.
        weather: '',
        temperature: '',
        contractor: '',
        workType: 'SITE_INSPECTION',
        boqItemId: '',
      });
      setDailyFields({
        workExecutedToday: '',
        workLocation: '',
        manpowerSummary: '',
        risksHindrances: '',
        materialsReceivedSummary: '',
      });
      setCustomSections([]);
      setPhotos([]);
      setNotes('');
      setShowDraftBanner(false);
    };
    window.addEventListener('draft:clear-current', handler);
    return () => window.removeEventListener('draft:clear-current', handler);
  }, [currentEmployeeId]);

  // Load today's inspection records so the summary card shows real data
  // while the engineer fills in the DPR. If none exist, the empty state
  // promotes the "Create inspection record →" link.
  const loadTodayInspections = useCallback(async () => {
    if (!accessToken) return;
    setTodayInspectionsLoaded(true);
    try {
      const data = await api.getInspections(
        { reportDate: form.reportDate, limit: '20' },
        accessToken
      );
      setTodayInspections(data.inspections || []);
    } catch {
      setTodayInspections([]);
    }
  }, [accessToken, form.reportDate]);

  useEffect(() => {
    loadTodayInspections();
  }, [loadTodayInspections]);

  // N7: load BOQ items for the named project. Debounced 400ms so the
  // request doesn't fire per keystroke; cleared when projectName is
  // empty (so switching projects back to "" doesn't keep stale items
  // in the selector). The selected boqItemId is reset to '' if it no
  // longer matches a loaded item — otherwise the form would carry a
  // dangling reference into a different project.
  //
  // [N1 Phase B] Project picker: the dropdown is driven by a one-time
  // GET /api/projects fetch on mount. We don't debounce this one —
  // the list is static for the duration of the form, so re-fetching
  // on every projectId change would just hammer the server.
  useEffect(() => {
    if (!accessToken || projectsLoaded) return undefined;
    let cancelled = false;
    (async () => {
      try {
        // [R34] Scope the project picker to projects the employee has
        // actually touched via DPR / Inspection / BoqItem / VariationOrder
        // / Drawing audit columns. Without `?scope=assigned` the backend
        // defaults to `?scope=mine` and returns every active project in
        // the org — which leaks admin test rigs (NEW-TYPED-PROJECT-XYZ,
        // R32-DROPDOWN-PROBE, RESOLVE-TEST-PROJECT-NEW) into the dropdown
        // of every field engineer. Matches My Projects (Round-31) +
        // My Drawings (Round-30 + 32.1).
        const data = await api.getProjects({ scope: 'assigned' }, accessToken);
        if (cancelled) return;
        const registered = (data.projects || []).map((p) => ({
          id: p.id, name: p.name, code: p.code || '', isRegistered: true,
        }));
        const registeredNames = new Set(registered.map((p) => p.name));
        const discovered = (data.discovered || [])
          .filter((d) => d.name && !registeredNames.has(d.name))
          .map((d) => ({ id: '', name: d.name, code: '', isRegistered: false }));
        setProjects([...registered, ...discovered]);
      } catch {
        // Non-fatal — the dropdown will render its empty state and the
        // user can still submit with whatever they type into the
        // backup "Other" branch.
      } finally {
        if (!cancelled) setProjectsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
    // accessToken omitted — captures via closure; re-fetching on every
    // token refresh would race against an in-flight 401.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);
  useEffect(() => {
    const trimmed = (form.projectName || '').trim();
    if (!trimmed || !accessToken) {
      setBoqItems([]);
      setBoqItemsLoaded(false);
      return undefined;
    }
    const t = setTimeout(async () => {
      try {
        const data = await api.getBoqItems(
          { projectName: trimmed, isActive: 'true', limit: '100' },
          accessToken
        );
        setBoqItems(data.items || []);
        setBoqItemsLoaded(true);
        // If the currently-selected boqItemId doesn't belong to the
        // freshly-loaded project list, drop it. This catches the
        // "project renamed mid-form" edge case.
        setForm((f) => {
          if (!f.boqItemId) return f;
          const stillValid = (data.items || []).some((b) => b.id === f.boqItemId);
          return stillValid ? f : { ...f, boqItemId: '' };
        });
      } catch {
        setBoqItems([]);
        setBoqItemsLoaded(true);
      }
    }, 400);
    return () => clearTimeout(t);
    // accessToken omitted from deps — the function captures it via the
    // closure and re-running on every token refresh would cause a
    // 400ms-flush of unrelated network traffic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.projectName]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  // [N1 Phase B + bug fix] Project picker change handler. The dropdown's
  // value is either a UUID (registered project) or a name (discovered
  // project with no Project row yet). For discovered rows we call
  // POST /api/projects/resolve to promote the name to a real Project
  // and get a UUID BEFORE downstream pickers (DrawingPicker, BOQ
  // refetch keyed on projectId) fire — the alternative leaves
  // form.projectId as the literal name, which makes DrawingPicker
  // 400 on the projectId UUID validator and causes the DPR POST to
  // fail. See backend/src/routes/projects.js POST /resolve for the
  // server side. Registered rows still take the synchronous fast path
  // so a known-project pick feels instant.
  const handleProjectChange = async (e) => {
    const value = e.target.value;
    if (!value) {
      setForm((f) => ({ ...f, projectId: '', projectName: '', boqItemId: '', drawingId: '', drawingRev: '' }));
      setCreateMode(false);
      setNewProjectName('');
      setResolveError('');
      return;
    }
    // [R34] "+ Create new project…" sentinel — flip into create-mode
    // and let the user type a fresh name. Resolution happens in
    // handleCreateProject, not here.
    if (value === '__create__') {
      setCreateMode(true);
      setNewProjectName('');
      setResolveError('');
      return;
    }
    const match = projects.find((p) => (p.id || p.name) === value);
    if (!match) {
      // Shouldn't happen — the option list is sourced from `projects`.
      // Defensive: keep the existing form untouched so we don't lose
      // data on a stale onChange.
      return;
    }

    // Fast path: registered row already has a UUID. Set both fields
    // synchronously so DrawingPicker fires with a valid FK.
    if (match.id) {
      setForm((f) => ({
        ...f,
        projectId: match.id,
        projectName: match.name,
        boqItemId: '',
        drawingId: '',
        drawingRev: '',
      }));
      return;
    }

    // Discovered row: promote to a real Project. Optimistically set
    // projectName so the UI feels instant, then swap in the UUID once
    // the resolve resolves. If the call fails the DPR backend's
    // resolveProject() fallback still accepts the bare name at submit
    // time — we just lose the drawing picker for this submission.
    setForm((f) => ({
      ...f,
      projectId: '',
      projectName: match.name,
      boqItemId: '',
      drawingId: '',
      drawingRev: '',
    }));
    setResolvingProject(true);
    try {
      const resolved = await api.resolveProject(match.name, accessToken);
      const uuid = resolved?.id || '';
      if (!uuid) {
        toast.push('Could not register that project — try again', 'warning');
        return;
      }
      // Update the cached projects list so the option now carries the
      // UUID — future picks (and re-renders) use the registered path.
      setProjects((prev) => prev.map((p) => (
        p.name === match.name ? { ...p, id: uuid, isRegistered: true } : p
      )));
      setForm((f) => ({ ...f, projectId: uuid }));
    } catch (err) {
      console.warn('Project resolve failed', { message: err?.message?.split('\n')[0] });
      toast.push('Could not register project name; submit will retry', 'warning');
    } finally {
      setResolvingProject(false);
    }
  };

  // [R34] Inline create-new-project flow. Triggered by the Create button
  // in the inline name input that appears after the user picks the
  // `__create__` sentinel from the project picker. Mirrors
  // DrawingsBrowse.jsx#handleCreateProject: POST /api/projects/resolve
  // returns the existing Project (case-insensitive lookup) or creates
  // one with createdById=req.employeeId. On success: merge the row into
  // the picker + select it as the form's project. On error: surface a
  // friendly message (including PROJECT_INACTIVE for archived names).
  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name || resolvingProject) return;
    setResolvingProject(true);
    setResolveError('');
    try {
      const proj = await api.resolveProject(name, accessToken);
      // Merge into the projects list so the picker shows the new project
      // for the rest of the session. resolveProject returns the row
      // normalized via serializeProject (id, name, code, isActive…).
      setProjects((prev) => (prev.some((p) => p.id === proj.id) ? prev : [...prev, proj]));
      setForm((f) => ({
        ...f,
        projectId: proj.id,
        projectName: proj.name,
        boqItemId: '',
        drawingId: '',
        drawingRev: '',
      }));
      setCreateMode(false);
      setNewProjectName('');
    } catch (err) {
      const code = err?.code;
      if (code === 'PROJECT_INACTIVE') {
        setResolveError(`"${name}" is archived. Ask an admin to reactivate it.`);
      } else {
        setResolveError(err?.message || `Couldn't find or create "${name}".`);
      }
    } finally {
      setResolvingProject(false);
    }
  };

  const handleDailyChange = (e) => {
    const { name, value } = e.target;
    setDailyFields((f) => ({ ...f, [name]: value }));
  };

  const removePhoto = (idx) => {
    setPhotos((p) => {
      const removed = p[idx];
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        photoObjectUrlsRef.current.delete(removed.previewUrl);
      }
      return p.filter((_, i) => i !== idx);
    });
    setUploadStatuses((s) => {
      const next = { ...s };
      delete next[idx];
      return next;
    });
  };

  const updateUploadStatus = (tempId, patch) => {
    setUploadStatuses((s) => ({ ...s, [tempId]: { ...(s[tempId] || {}), ...patch } }));
  };

  // SOL DR-004: after a successful PUT (DRAFT or SUBMITTED), flip the
  // `persisted` flag on the photos we just sent so the next Save treats
  // them as server-owned. Without this, every subsequent Save re-sends
  // the same additions and relies on server-side dedupe — which works,
  // but trips an unnecessary dedupe round-trip and silently masks a
  // client bug if someone disables dedupe in the future. The flag is
  // keyed on `(container, ulid)` so a stale page that rehydrated the
  // same photo from a different employee still flips cleanly.
  const markPhotosPersisted = (acknowledgedPhotos) => {
    if (!Array.isArray(acknowledgedPhotos) || acknowledgedPhotos.length === 0) return;
    const ackKeys = new Set(
      acknowledgedPhotos
        .filter((p) => p && p.ulid && p.container)
        .map((p) => `${p.container}::${p.ulid}`),
    );
    setPhotos((prev) => prev.map((p) => (
      p && p.ulid && p.container && ackKeys.has(`${p.container}::${p.ulid}`)
        ? { ...p, persisted: true }
        : p
    )));
  };

  const handleFiles = async (files) => {
    const arr = Array.from(files);
    const valid = arr.filter(
      (f) => ACCEPTED_PHOTO_TYPES.includes(f.type) && f.size <= MAX_PHOTO_BYTES
    );
    if (valid.length === 0) {
      const msg = `Select valid images (jpg/png/webp, max ${MAX_PHOTO_BYTES / 1024 / 1024}MB each)`;
      setError(msg);
      toast.push(msg, 'warning');
      return;
    }
    if (photos.length + valid.length > MAX_PHOTOS_PER_DPR) {
      const msg = `Max ${MAX_PHOTOS_PER_DPR} photos allowed`;
      setError(msg);
      toast.push(msg, 'warning');
      return;
    }

    setError('');

    const completed = [];
    const failed = [];

    for (const file of valid) {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = URL.createObjectURL(file);
      photoObjectUrlsRef.current.add(previewUrl);
      updateUploadStatus(tempId, { status: 'uploading', progress: 0, filename: file.name });

      try {
        const { sasUrl, ulid } = await api.getDprSasUrl(file.name, file.type, 'dpr-photos', accessToken);
        updateUploadStatus(tempId, { status: 'uploading', progress: 0 });

        await uploadBlob(sasUrl, file, {
          contentType: file.type,
          onProgress: (pct) => updateUploadStatus(tempId, { status: 'uploading', progress: pct }),
        });

        await api.confirmUpload(ulid, 'dpr-photos', file.name, file.type, file.size, accessToken);

        updateUploadStatus(tempId, { status: 'complete', progress: 100 });
        completed.push({
          ulid,
          container: 'dpr-photos',
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          caption: '',
          location: '',
          takenAt: new Date().toISOString(),
          previewUrl,
        });
      } catch (err) {
        updateUploadStatus(tempId, { status: 'error', error: err.message, filename: file.name });
        failed.push({ filename: file.name, error: err.message });
      }
    }

    if (completed.length > 0) setPhotos((p) => [...p, ...completed]);
    if (failed.length > 0) {
      const summary = failed.length === 1
        ? `Failed to upload ${failed[0].filename}: ${failed[0].error}`
        : `Failed to upload ${failed.length} photo${failed.length !== 1 ? 's' : ''}.`;
      toast.push(summary, 'error');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  // SOL DR-005 (audit 2026-09-08): shared, explicit payload construction
  // for every DPR write the form can make. The audit caught two divergent
  // call sites — a POST that omitted `drawingId`/`drawingRev` (so the
  // server stored `NULL` for the link the user clearly selected) and a PUT
  // on a resumed draft that omitted `photos` (so newly-added evidence was
  // silently dropped). Defining one builder that every branch consumes
  // removes the divergence and makes it impossible for a future edit to
  // fall back out of sync.
  //
  // Modes:
  //   - newDraft     — POST /api/dpr with status:DRAFT  (Save Draft)
  //   - newFinal     — POST /api/dpr with status:SUBMITTED  (first-time submit)
  //   - resumedEdit  — PUT /api/dpr/:id (DRAFT resume Save Draft)
  //   - publish      — POST /api/dpr/:id/submit — no body at all, dedicated
  //                    endpoint owns the DRAFT -> SUBMITTED transition
  //                    (DR-003). The helper returns null in this mode so
  //                    the call site is explicit that there is no body to
  //                    shape.
  const buildDprPayload = useCallback(
    ({ form: f, dailyFields: d, customSections: c, photosToSubmit: p, serializedManpower: m, mode }) => {
      if (mode === 'publish') return null;
      const payload = {
        // [N1 Phase B] projectId is the FK; projectName is the denormalized
        // legacy string. Both come from form state and are set atomically
        // in handleProjectChange so they can't drift apart.
        projectId: f.projectId || null,
        projectName: f.projectName,
        location: f.location,
        reportDate: f.reportDate,
        weather: f.weather,
        temperature: f.temperature,
        contractor: f.contractor,
        workType: f.workType,
        notes: notes || null,
        // Round-12: 5 daily-narrative PMC fields.
        workExecutedToday: d.workExecutedToday || null,
        workLocation: d.workLocation || null,
        manpowerSummary: m || null,
        risksHindrances: d.risksHindrances || null,
        materialsReceivedSummary: d.materialsReceivedSummary || null,
        // User-added ad-hoc text + table sections.
        customSections: Array.isArray(c) && c.length > 0 ? c : null,
        // N7: optional BOQ link. null when unset so the backend treats it
        // as "no link" rather than a literal "".
        boqItemId: f.boqItemId || null,
        // N3 (Phase F): optional drawing stamp. drawingId is the FK;
        // drawingRev is denormalized so the wire record survives the
        // original drawing being renamed or superseded.
        drawingId: f.drawingId || null,
        drawingRev: f.drawingRev || null,
        // Photos: included on every mode that has a body. The backend
        // PUT handler treats `photos: []` and `photos` undefined as
        // "no additions" — existing DPRPhoto rows are never touched,
        // which is the audit's explicit guarantee ("counters refuted
        // deletion of previously bound server photos").
        photos: Array.isArray(p) ? p : [],
      };
      // Status is only ever set on the create paths. The PUT mass-
      // assignment allowlist deliberately excludes `status` — DR-003 made
      // the publish transition its own endpoint. For resumed edits, the
      // server keeps the existing status untouched.
      if (mode === 'newDraft') payload.status = 'DRAFT';
      else if (mode === 'newFinal') payload.status = 'SUBMITTED';
      // mode === 'resumedEdit' → no `status` field.
      return payload;
    },
    [notes]
  );

  const handleSubmit = async (submitStatus) => {
    if (submittingRef.current) return;
    submittingRef.current = true;

    setError('');
    // [DR-006 client] Refuse to submit while any photo is still uploading
    // or awaiting CONFIRMED intent. Without this, the user can submit a
    // report that drops photos mid-upload — the backend now rolls the
    // record back (409 PHOTO_BINDING_LOST) and the user is left wondering
    // why their report vanished. Block the submit instead and surface a
    // concrete reason.
    const inFlightUploads = Object.values(uploadStatuses).filter(
      (s) => s && (s.status === 'requesting-sas' || s.status === 'uploading' || s.status === 'confirming'),
    );
    if (inFlightUploads.length > 0) {
      const msg = `${inFlightUploads.length} photo${inFlightUploads.length !== 1 ? 's are' : ' is'} still uploading — please wait for them to finish before submitting.`;
      setError(msg);
      toast.push(msg, 'warning');
      submittingRef.current = false;
      return;
    }
    if (!form.projectName || !form.location || !form.reportDate) {
      const msg = 'Project name, location, and date are required';
      setError(msg);
      toast.push(msg, 'warning');
      submittingRef.current = false;
      return;
    }
    if (!form.workType) {
      const msg = 'Primary work category is required';
      setError(msg);
      toast.push(msg, 'warning');
      submittingRef.current = false;
      return;
    }
    const dateErr = validateReportDate(form.reportDate);
    if (dateErr) {
      setError(dateErr);
      toast.push(dateErr, 'warning');
      submittingRef.current = false;
      return;
    }
    // SOL-P2 #11: derive the on-the-wire manpowerSummary string from the
    // structured rows at the very last moment so the submit payloads
    // (PUT + POST) carry the same value the rest of the form would have
    // produced, regardless of whether the engineer used the row builder
    // or pasted legacy text into a single row.
    const serializedManpower = serializeManpowerRows(manpowerRows);

    // SOL-P1#11: require at least one piece of meaningful content before
    // final submission. The audit caught that project+location+date was
    // enough to submit, leaving admins reviewing an empty DPR.
    if (submitStatus === 'SUBMITTED') {
      const hasNarrative = (
        (dailyFields.workExecutedToday && dailyFields.workExecutedToday.trim().length > 0) ||
        (dailyFields.manpowerSummary && dailyFields.manpowerSummary.trim().length > 0) ||
        (dailyFields.materialsReceivedSummary && dailyFields.materialsReceivedSummary.trim().length > 0) ||
        (notes && notes.trim().length > 0) ||
        photos.length > 0
      );
      if (!hasNarrative) {
        const msg = 'Add at least one work item, manpower note, materials note, or photo before submitting.';
        setError(msg);
        toast.push(msg, 'warning');
        submittingRef.current = false;
        return;
      }
    }

    setStatus('submitting');

    try {
      // SOL DR-004: only send NEW additions on Save. Server-loaded
      // photos carry `persisted: true` from the hydration path above;
      // freshly-uploaded photos default to `persisted: false` (see
      // handleFiles). Sending persisted rows back would force the
      // server to dedupe them and, on a stale client, can still slip
      // a duplicate through — the additive semantic is the safer
      // contract and matches the audit's explicit guidance.
      const photosToSubmit = photos
        .filter((p) => p.ulid && !p.persisted)
        .map(({ ulid, container, filename, contentType, sizeBytes, caption, location, takenAt }) => ({
          ulid, container, filename, contentType, sizeBytes, caption, location, takenAt,
        }));
      if (photosToSubmit.length === 0 && Object.values(uploadStatuses).some((s) => s.status === 'error')) {
        const msg = 'All photo uploads failed. Please re-add photos before submitting.';
        setError(msg);
        setStatus('idle');
        toast.push(msg, 'error');
        submittingRef.current = false;
        return;
      }

      // SOL DR-004: when editing an existing server-side draft, PUT the
      // update with the version we read on load — backend enforces the
      // optimistic lock. The api signature is `updateDpr(id, data, version,
      // token)`; previous code passed the token in the version slot AND
      // embedded version in the body, which both mis-set the version field
      // AND left the PUT unauthenticated.
      if (editingId) {
        // SOL DR-003: the PUT mass-assignment allowlist deliberately
        // excludes `status`, so the Submit Report gesture cannot ride the
        // same PUT as Save Draft — the publish transition would be
        // silently dropped. Branch on the gesture: DRAFT keeps the PUT
        // (no behavior change), SUBMITTED calls the dedicated
        // /:id/submit command which transitions DRAFT -> SUBMITTED and
        // returns the row in its terminal state.
        //
        // CRITICAL DR-003 fix: when the user resumes an existing draft and
        // then clicks Submit Report, the form may carry pending edits —
        // newly added photos, drawing/BOQ selections, or narrative
        // changes — that the server has never seen. The previous flow
        // called submitDpr directly with the pre-resume version, so every
        // pending edit was silently dropped (SUBMITTED row landed with
        // zero photos and null drawing/BOQ references). Restructure:
        //   1. PUT the resumed-edit payload first (same body Save Draft
        //      uses) so the server acknowledges the additions and bumps
        //      the version.
        //   2. Capture the server-acknowledged version from the PUT
        //      response — the version we LOADED is stale as soon as PUT
        //      commits, so a submit against the pre-PUT version would
        //      409 VERSION_CONFLICT.
        //   3. Call submitDpr with the POST-PUT version. If PUT fails,
        //      ABORT the submit — never publish stale draft content.
        //   4. On a retry (PUT succeeded but submit failed or its
        //      response was lost), do NOT re-PUT — the photo additions
        //      are already persisted and a second PUT would either
        //      double-create them or be a no-op that wastes a version
        //      increment. GET the current row state to reconcile the
        //      acknowledged version (and recognize a SUBMITTED row as
        //      success).
        if (submitStatus === 'SUBMITTED') {
          let versionToSubmit = editingVersion;

          if (lastPutVersionRef.current != null) {
            // Retry path: a previous attempt PUT'd successfully but the
            // publish call (or its response) didn't land cleanly. GET the
            // current row to (a) recognize SUBMITTED as "we already
            // succeeded" and (b) pick up any version that advanced past
            // our last acknowledged revision (e.g. another admin action
            // raced in). NEVER re-PUT here — photo rows are already
            // persisted on the server.
            try {
              const current = await api.getDpr(editingId, accessToken);
              if (current && current.status === 'SUBMITTED') {
                toast.push('DPR submitted successfully.', 'success');
                lastPutVersionRef.current = null;
                navigate('/portal/dpr/my');
                return;
              }
              versionToSubmit = current && Number.isInteger(current.version)
                ? current.version
                : lastPutVersionRef.current;
              lastPutVersionRef.current = versionToSubmit;
            } catch (getErr) {
              const msg = getErr.message || 'Could not verify draft state. Please refresh and try again.';
              setError(msg);
              setStatus('idle');
              if (getErr.status !== 401) toast.push(msg, 'error');
              submittingRef.current = false;
              return;
            }
          } else {
            // First attempt: PUT the resumed-edit payload so all pending
            // additions (photos, drawings, BOQ, narrative) land on the
            // server. Capture the acknowledged version. ABORT on failure
            // — silently publishing stale draft content was the original
            // DR-003 bug.
            const resumePayload = buildDprPayload({
              form,
              dailyFields,
              customSections,
              photosToSubmit,
              serializedManpower,
              mode: 'resumedEdit',
            });
            let putResult;
            try {
              putResult = await api.updateDpr(
                editingId,
                resumePayload,
                editingVersion,
                accessToken,
              );
            } catch (putErr) {
              // PUT failed — do NOT submit. A 409 VERSION_CONFLICT means
              // another writer raced past us (the local draft is stale);
              // ask the user to refresh so they don't lose their edits
              // silently. Any other failure (network, server error)
              // likewise means the additions never landed, so publishing
              // the pre-PUT version would resurrect the original bug.
              const isVersionConflict =
                putErr?.code === 'VERSION_CONFLICT' || putErr?.status === 409;
              const msg = isVersionConflict
                ? 'This draft was modified elsewhere. Please refresh the page and try again.'
                : (putErr.message || 'Could not save your edits before submitting.');
              setError(msg);
              setStatus('idle');
              if (putErr.status !== 401) toast.push(msg, 'error');
              submittingRef.current = false;
              return;
            }

            const acknowledged = putResult && Number.isInteger(putResult.version)
              ? putResult.version
              : null;
            if (acknowledged == null) {
              // Server didn't return a version we can use. Don't guess —
              // abort so the user knows to refresh instead of seeing a
              // confusing 409 from a wrong-version submit.
              const msg = 'Could not confirm saved changes. Please refresh and try again.';
              setError(msg);
              setStatus('idle');
              toast.push(msg, 'error');
              submittingRef.current = false;
              return;
            }
            versionToSubmit = acknowledged;
            lastPutVersionRef.current = acknowledged;
          }

          const submitted = await api.submitDpr(editingId, versionToSubmit, accessToken);
          // Show success ONLY for the returned terminal state. If the
          // server returned something else (e.g. an idempotent retry
          // where the row was already SUBMITTED), the round-trip still
          // succeeded — surface the same success path. Otherwise treat it
          // as the publish didn't land and stay on the form.
          if (submitted && submitted.status === 'SUBMITTED') {
            // SOL DR-004: acknowledge the photos we just sent so the
            // additive flag flips and any subsequent edit treats them
            // as already persisted. Same keying as the Save branch.
            markPhotosPersisted(photosToSubmit);
            toast.push('DPR submitted successfully.', 'success');
            lastPutVersionRef.current = null;
            navigate('/portal/dpr/my');
          } else {
            toast.push('Submit did not complete. Please refresh and try again.', 'error');
            setStatus('idle');
            submittingRef.current = false;
            return;
          }
        } else {
          // SOL DR-005: build the resumed-edit PUT body via the shared
          // helper. The previous inline literal here omitted `photos`,
          // so newly-added evidence on a resumed draft was silently
          // dropped. The helper always includes the four evidence-link
          // fields (drawingId, drawingRev, boqItemId, photos) along with
          // the narrative set, so a future caller can't regress this.
          const resumePayload = buildDprPayload({
            form,
            dailyFields,
            customSections,
            photosToSubmit,
            serializedManpower,
            mode: 'resumedEdit',
          });
          await api.updateDpr(
            editingId,
            resumePayload,
            editingVersion,
            accessToken
          );
          // SOL DR-004: acknowledge the photos we just sent so the
          // next Save treats them as persisted. Without this flag the
          // same additions would be re-sent on every subsequent edit,
          // relying solely on server-side dedupe. Flipping the flag
          // locally makes the additive semantic observable in the UI
          // and removes the dedupe load from the server entirely for
          // the unchanged-Save case.
          markPhotosPersisted(photosToSubmit);
          toast.push('Draft updated.', 'success');
          navigate('/portal/dpr/my');
        }
      } else {
        // DR-012: mint a fresh idempotency key per submit intent. The
        // backend stores (employeeId, Idempotency-Key, bodyHash) → 201
        // for 5 minutes so a NETWORK_ERROR retry (api.js:168-178)
        // replays the same key + body and returns the cached row
        // instead of creating a duplicate DPR + duplicate admin
        // notification email. Submitting twice intentionally mints
        // TWO keys (a second submit click is a fresh user intent).
        const idempotencyKey = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
          ? crypto.randomUUID()
          : `dpr-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // SOL DR-005: build the create body via the shared helper. The
        // previous inline literal omitted `drawingId` and `drawingRev`,
        // so a fresh final DPR that picked a drawing would land
        // drawingId=NULL even though the UI selected one. The helper
        // carries all four evidence-link fields through both create and
        // edit, so the round-trip is the same shape on every code path.
        const createPayload = buildDprPayload({
          form,
          dailyFields,
          customSections,
          photosToSubmit,
          serializedManpower,
          mode: submitStatus === 'DRAFT' ? 'newDraft' : 'newFinal',
        });
        await api.createDpr(createPayload, accessToken, idempotencyKey);
        clearDraftForEmployee(currentEmployeeId);
        toast.push(submitStatus === 'DRAFT' ? 'Draft saved.' : 'DPR submitted successfully.', 'success');
        navigate('/portal/dpr/my');
      }
    } catch (err) {
      // [DR-006 client] Surface a specific message when the server rolls
      // back because a photo claim was lost mid-submit. Generic
      // "Failed to submit…" would leave the user thinking the form was
      // broken; the real story is "photos were orphaned by the sweep,
      // re-attach and resubmit".
      const isPhotoBindingLost = err?.code === 'PHOTO_BINDING_LOST'
        || (err?.message || '').toLowerCase().includes('photo binding');
      const msg = isPhotoBindingLost
        ? 'Photo upload was lost mid-submit — please re-attach your photos and try again.'
        : (err.message || 'Failed to submit DPR');
      setError(msg);
      setStatus('idle');
      if (err.status !== 401) toast.push(msg, 'error');
    } finally {
      submittingRef.current = false;
    }
  };

  const handleDiscardDraft = () => {
    // SOL DR-007 (round-23): "Discard / start fresh" must clear the
    // edit identity, version, and URL `?draftId=<id>` so the next Save
    // creates a fresh POST instead of overwriting the original draft
    // via PUT. The audit's exact wording: "start fresh clears edit
    // identity/version/query/claims/pending work while preserving the
    // old saved row". We preserve the saved row server-side — we only
    // detach the local edit session from it.
    const wasEditingServerDraft = Boolean(editingId);
    clearDraftForEmployee(currentEmployeeId);
    setForm({
      // [N1 Phase B] reset both projectId + projectName in lockstep.
      projectId: '',
      projectName: '',
      location: '',
      reportDate: getLocalDate(),
      // BUG-2 (round-37): empty default; see comment at line 201.
      weather: '',
      temperature: '',
      contractor: '',
      workType: 'SITE_INSPECTION',
      boqItemId: '',
      // N3: drawing stamp resets with the rest of the form so a
      // discarded draft doesn't carry the previous drawing link.
      drawingId: '',
      drawingRev: '',
    });
    setDailyFields({
      workExecutedToday: '',
      workLocation: '',
      manpowerSummary: '',
      risksHindrances: '',
      materialsReceivedSummary: '',
    });
    // SOL-P2 #11: also reset the structured workforce rows.
    setManpowerRows([{ trade: '', count: '', hours: '' }]);
    setCustomSections([]);
    setNotes('');
    setShowDraftBanner(false);
    if (wasEditingServerDraft) {
      // Detach from the server-side draft — next Save must POST /api/dpr,
      // not PUT /api/dpr/:editingId. Also invalidate the hydration
      // guard so a future navigation back to the same URL re-fetches,
      // and clear the acknowledged-PUT ref so a stale version doesn't
      // leak across the new (create-mode) session.
      setEditingId(null);
      setEditingVersion(null);
      lastPutVersionRef.current = null;
      lastHydratedDraftIdRef.current = null;
      // Drop the `?draftId=<id>` query so the URL no longer claims
      // we're editing that row.
      if (draftId) {
        const next = new URLSearchParams(searchParams);
        next.delete('draftId');
        setSearchParams(next, { replace: true });
      }
    }
    toast.push('Draft discarded.', 'info');
  };

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <h1 className="dpr-page-title">Submit Daily Progress Report</h1>
        <p style={{ color: 'var(--steel)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Daily narrative for the cover page. Detailed material receipts,
          NCRs, and safety records go on the
          {' '}<Link to="/portal/inspection/submit">Inspection &amp; Compliance</Link> page.
        </p>

        {/* SOL-P1#11: progressive-disclosure progress strip. Each section
            reports its completion state; the user sees a fill bar + check
            chips so they know what's still missing before they hit Submit. */}
        <FormProgress
          label="DPR completion"
          sections={[
            {
              id: 'dpr-section-site',
              label: DPR_SECTIONS[0].label,
              complete: Boolean(form.projectName && form.location && form.reportDate && form.workType),
            },
            {
              id: 'dpr-section-narrative',
              label: DPR_SECTIONS[1].label,
              complete: Boolean(
                (dailyFields.workExecutedToday && dailyFields.workExecutedToday.trim().length > 0) ||
                (dailyFields.manpowerSummary && dailyFields.manpowerSummary.trim().length > 0) ||
                (dailyFields.materialsReceivedSummary && dailyFields.materialsReceivedSummary.trim().length > 0) ||
                (notes && notes.trim().length > 0)
              ),
            },
            {
              id: 'dpr-section-photos',
              label: DPR_SECTIONS[2].label,
              complete: photos.length > 0,
            },
            {
              id: 'dpr-section-custom',
              label: DPR_SECTIONS[3].label,
              complete: customSections.length > 0,
            },
            {
              id: 'dpr-section-inspections',
              label: DPR_SECTIONS[4].label,
              complete: todayInspections.length > 0,
            },
          ]}
        />

        {showDraftBanner && (
          <div
            role="status"
            className="draft-banner"
          >
            {/* [DR-032] Inline `flex: 1` (which expands to `flex: 1 1 0%`)
                overrode the stylesheet contract at .draft-banner > span
                (`flex: 1 1 200px; min-width: 0;`). The `0%` basis +
                flex-shrink collapsed the text to one character per line
                at 375px. Let the stylesheet handle the layout. */}
            <span>📝 Restored unsaved draft from your previous visit.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowDraftBanner(false)}>
              Dismiss
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleDiscardDraft}>
              Discard
            </button>
          </div>
        )}

        {/* SOL DR-006: an orphaned / unowned local draft was found in
            storage. We cannot prove authorship, so the form is NOT pre-
            filled — instead we surface an explicit banner explaining
            why the draft cannot be restored and offer a Discard affordance
            that wipes the orphaned value from localStorage. Mirrors the
            malformed-draft banner in InspectionSubmit.jsx. */}
        {quarantinedReason && (
          <div
            role="alert"
            className="portal-auth-error"
            style={{ marginBottom: '1rem' }}
          >
            <strong>We couldn't restore a previous draft.</strong>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              An unsaved draft was found in this browser, but we can't
              confirm who it belongs to, so its content has not been
              loaded into the form. Start a fresh entry below, or discard
              the orphan draft to clear this banner.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: '0.75rem' }}
              onClick={handleDiscardDraft}
            >
              Discard orphan draft and start fresh
            </button>
          </div>
        )}

        {/* DR-003 banner: when the user reopens a saved DRAFT draft via
            Resume, the form fields are pre-filled with values cached from
            their previous submit (the SUBMITTED path no longer clears
            localStorage so the engineer can copy fields forward). Without
            this hint the user might file a duplicate against the wrong
            date. Only shows when `editingId` is set; the load effect at
            line 311 already enforced `d.status === 'DRAFT'` before
            setting `editingId`, so `editingId` alone is sufficient.
            Reuses the existing `.draft-banner` class — same AA-compliant
            palette and round-37 mobile-wrap fix as `showDraftBanner`.
            The Discard button calls `handleDiscardDraft`, which resets the
            form state and clears localStorage (same handler the
            `showDraftBanner` block uses), so the engineer can get a clean
            slate instead of having to change the project/date. */}
        {editingId && (
          <div role="status" className="draft-banner">
            <span>
              Draft cached from your last submit. Hit Discard to clear, or change the project/date to file a fresh one.
            </span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleDiscardDraft}>
              Discard
            </button>
          </div>
        )}

        {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

        <div className="dpr-form">
          {/* A-11: section anchor — see DPR_SECTIONS for the matching skip-nav target. */}
          <section id="dpr-section-site" className="dpr-form-section">
          {/* Project metadata — [N1 Phase B] dropdown of registered +
              auto-discovered projects. The picker is the source of
              truth for projectId; the denormalized projectName field
              is set in lockstep by handleProjectChange. We still allow
              no pick so an employee can submit a DPR for a brand-new
              project name (the backend's resolveProject() auto-creates
              a discovered row on POST). */}
          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <label htmlFor="projectId">Project *</label>
              {!projectsLoaded ? (
                <select id="projectId" className="form-input" disabled>
                  <option>Loading projects…</option>
                </select>
              ) : (
                <select
                  id="projectId"
                  name="projectId"
                  className="form-input"
                  // [Bug fix] Disable while POST /api/projects/resolve is
                  // in flight so the user can't pick a different row
                  // mid-call (which would race against the optimistic
                  // setProjects swap above).
                  disabled={resolvingProject}
                  // Value is the projectId (UUID) for registered rows
                  // or the name for discovered rows; an empty string
                  // represents "no pick yet". We resolve the current
                  // form's projectId to the dropdown's value so legacy
                  // drafts (which only have projectName) still highlight
                  // the right option. [R34] When in create-mode the
                  // select shows the `__create__` sentinel so the user
                  // sees where they are after picking "+ Create new
                  // project…".
                  value={createMode ? '__create__' : (() => {
                    if (form.projectId) return form.projectId;
                    if (form.projectName) {
                      const match = projects.find((p) => p.name === form.projectName);
                      return (match?.id) || form.projectName;
                    }
                    return '';
                  })()}
                  onChange={handleProjectChange}
                  aria-busy={resolvingProject}
                >
                  <option value="">— Select a project —</option>
                  {projects.map((p) => (
                    <option key={p.id || p.name} value={p.id || p.name}>
                      {p.name}{p.code ? ` (${p.code})` : ''}{!p.isRegistered ? ' · auto-discovered' : ''}
                    </option>
                  ))}
                  {/* [R34] Sentinel + create-mode affordance — mirrors
                      DrawingsBrowse.jsx. The option is always visible
                      (after the real projects) so a field engineer with
                      zero curated projects can still file a DPR against
                      a brand-new site name without dropping to a "type
                      it in and submit anyway" workaround. */}
                  <option value="__create__">+ Create new project…</option>
                </select>
              )}
              {/* [Bug fix] Distinguish the in-flight resolve from the
                  not-yet-started state so the user understands why the
                  picker is briefly disabled after picking a discovered
                  row. */}
              {form.projectName ? (
                <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                  Picked: <strong>{form.projectName}</strong>
                  {(() => {
                    if (resolvingProject) return ' · registering project…';
                    if (!form.projectId) return ' · not yet registered';
                    return '';
                  })()}
                </span>
              ) : null}
              {/* [R34] Inline create-new-project form. Mirrors
                  DrawingsBrowse.jsx:409-466 — name input + Create/Cancel
                  buttons that call api.resolveProject via
                  handleCreateProject. Escape cancels, Enter submits. */}
              {createMode && (
                <div
                  className="dpr-create-project"
                  role="group"
                  aria-label="Create new project"
                  style={{
                    marginTop: '0.5rem',
                    display: 'flex',
                    gap: '0.5rem',
                    alignItems: 'flex-end',
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <label
                      htmlFor="dpr-new-project-name"
                      style={{ fontSize: '0.8rem', color: 'var(--steel)' }}
                    >
                      New project name
                    </label>
                    <input
                      id="dpr-new-project-name"
                      type="text"
                      className="form-input"
                      value={newProjectName}
                      onChange={(e) => { setNewProjectName(e.target.value); setResolveError(''); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleCreateProject();
                        } else if (e.key === 'Escape') {
                          setCreateMode(false);
                          setNewProjectName('');
                          setResolveError('');
                        }
                      }}
                      disabled={resolvingProject}
                      placeholder="e.g. New Site — Chennai ECR"
                      aria-label="New project name"
                      autoFocus
                    />
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleCreateProject}
                    disabled={resolvingProject || !newProjectName.trim()}
                  >
                    {resolvingProject ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      setCreateMode(false);
                      setNewProjectName('');
                      setResolveError('');
                    }}
                    disabled={resolvingProject}
                  >
                    Cancel
                  </button>
                </div>
              )}
              {resolveError && (
                <div
                  role="alert"
                  style={{ fontSize: '0.85rem', color: 'var(--danger, #c0392b)', marginTop: '0.25rem' }}
                >
                  {resolveError}
                </div>
              )}
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label htmlFor="reportDate">Report Date</label>
              <input
                id="reportDate"
                type="date"
                name="reportDate"
                className="form-input"
                value={form.reportDate}
                onChange={handleChange}
                max={getLocalDate()}
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="location">Location *</label>
            <input id="location" name="location" className="form-input" value={form.location} onChange={handleChange} placeholder="Site address or location description" />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="weather">Weather</label>
              <select id="weather" name="weather" className="form-input" value={form.weather} onChange={handleChange}>
                {/* BUG-2 (round-37): explicit empty option so the engineer
                    actively picks weather rather than silently inheriting
                    a Sunny default. Hidden by the standard 'required'
                    validation when finalising as SUBMITTED. */}
                <option value="" disabled>(no selection — pick or confirm)</option>
                {WEATHER_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="temperature">Temperature</label>
              <input id="temperature" name="temperature" className="form-input" value={form.temperature} onChange={handleChange} placeholder="e.g. 32°C" />
            </div>
            <div className="form-group">
              <label htmlFor="contractor">Contractor</label>
              <input id="contractor" name="contractor" className="form-input" value={form.contractor} onChange={handleChange} placeholder="Contractor name" />
            </div>
          </div>

          {/* N3 (Phase F): optional drawing stamp. DrawingPicker reads
              the active register for the chosen projectId and emits
              {drawingId, drawingRev} via onChange. Empty when the
              project is unregistered (discovered-only) — the picker
              renders its own "Pick a project first" placeholder. */}
          <div className="form-group">
            <label htmlFor="drawingId">Drawing (optional)</label>
            <DrawingPicker
              projectId={form.projectId || ''}
              value={form.drawingId || ''}
              onChange={(drawingId, drawingRev) => {
                setForm((f) => ({
                  ...f,
                  drawingId: drawingId || '',
                  drawingRev: drawingRev || '',
                }));
              }}
              accessToken={accessToken}
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
              Stamp this report against a specific drawing revision. Ask
              the design lead to add drawings in the Drawings Register
              if none are listed.
            </span>
          </div>

          {/* N7: optional BOQ link. Dropdown is empty / disabled until
              the user names a project — the list re-fetches on
              debounced projectName change. "No BOQ items" includes a
              shortcut for admins to jump straight to the registry. */}
          <div className="form-group">
            <label htmlFor="boqItemId">BOQ Item Link (optional)</label>
            {(() => {
              const trimmedProject = (form.projectName || '').trim();
              if (!trimmedProject) {
                return (
                  <select id="boqItemId" className="form-input" disabled aria-disabled="true">
                    {/* BUG-3 (round-37): placeholder-as-real-value. `value=""`
                        makes the option truly empty (so no fake "name a
                        project" string ever lands in the wire payload);
                        `disabled` greys it out so a real BOQ item can't
                        accidentally re-select the placeholder. */}
                    <option value="" disabled>Name a project first to see BOQ items</option>
                  </select>
                );
              }
              if (!boqItemsLoaded) {
                return (
                  <select id="boqItemId" className="form-input" disabled aria-disabled="true" aria-busy="true">
                    <option value="" disabled>Loading BOQ items…</option>
                  </select>
                );
              }
              if (boqItems.length === 0) {
                return (
                  <div
                    style={{
                      padding: '0.5rem 0.75rem',
                      background: '#f8fafc',
                      border: '1px solid #e2e8f0',
                      borderRadius: 6,
                      fontSize: '0.85rem',
                      color: 'var(--steel)',
                    }}
                  >
                    No BOQ items for "{trimmedProject}".
                    {' '}
                    {employee?.isAdmin ? (
                      <Link to="/portal/admin/boq">Open BOQ Registry →</Link>
                    ) : (
                      <span>Ask the billing engineer to add some.</span>
                    )}
                  </div>
                );
              }
              return (
                <>
                  <select
                    id="boqItemId"
                    name="boqItemId"
                    className="form-input"
                    value={form.boqItemId || ''}
                    onChange={handleChange}
                  >
                    <option value="">— No BOQ link —</option>
                    {boqItems.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.itemCode} — {b.description}
                      </option>
                    ))}
                  </select>
                  {form.boqItemId && (() => {
                    const selected = boqItems.find((b) => b.id === form.boqItemId);
                    if (!selected) return null;
                    return (
                      <div
                        style={{
                          marginTop: '0.4rem',
                          padding: '0.5rem 0.75rem',
                          background: '#f0f9ff',
                          border: '1px solid #bae6fd',
                          borderRadius: 6,
                          fontSize: '0.8rem',
                          color: '#075985',
                        }}
                      >
                        <strong>{selected.itemCode}</strong> · {selected.unit} · qty {Number(selected.quantity).toLocaleString('en-IN')}
                      </div>
                    );
                  })()}
                </>
              );
            })()}
          </div>

          {/* Primary work category — backend-required tag for filtering on the admin dashboard. */}
          <div className="form-group">
            <label htmlFor="workType">Primary Work Category *</label>
            <select id="workType" name="workType" className="form-input" value={form.workType} onChange={handleChange}>
              {WORK_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
              Classifies today's narrative. Detailed material / QC / safety records
              are filed separately on the Inspection &amp; Compliance page.
            </span>
          </div>
          </section>

          {/* A-11: section anchor — daily narrative + catch-all notes. */}
          <section id="dpr-section-narrative" className="dpr-form-section">
          {/* Round-12: 5 daily-narrative PMC fields. */}
          <fieldset
            style={{
              border: '1px solid #e2e8f0',
              borderRadius: 8,
              padding: '1rem',
              margin: '1.5rem 0',
              background: '#fafbfc',
            }}
          >
            <legend style={{ padding: '0 0.5rem', fontWeight: 600, color: 'var(--navy)', fontSize: '0.9rem' }}>
              Daily Narrative
            </legend>

            <div className="form-group">
              <label htmlFor="workExecutedToday">
                Short notes on today's work
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <textarea
                id="workExecutedToday"
                name="workExecutedToday"
                className="form-input"
                rows={3}
                value={dailyFields.workExecutedToday}
                onChange={handleDailyChange}
                placeholder="e.g. Villa 4 GF slab casting completed (8 m³ M25); Villa 7 FF columns up to lintel level."
                style={{ resize: 'vertical', minHeight: '80px' }}
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                3–5 sentences. What was actually executed today.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="workLocation">
                Area of inspection carried out
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <input
                id="workLocation"
                name="workLocation"
                className="form-input"
                value={dailyFields.workLocation}
                onChange={handleDailyChange}
                placeholder="e.g. Villa 4 – GF Slab & Villa 7 – FF Columns"
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                Villa / block / floor or area reference.
              </span>
            </div>

            {/* SOL-P2 #11: workforce row builder. Each row is a Trade ×
                Count × Hours triple. We serialize back to a pipe-separated
                "Trade — Count — Hours" string at submit time so the
                existing `manpowerSummary` column keeps working unchanged.
                The `dailyFields.manpowerSummary` value stays in sync via
                a derived memo so handleSubmit doesn't have to know about
                the row shape. */}
            <div className="form-group">
              <label>
                Manpower
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <div className="dpr-manpower-rows" role="group" aria-label="Workforce by trade">
                {manpowerRows.map((row, idx) => (
                  <div key={idx} className="dpr-manpower-row">
                    <input
                      type="text"
                      aria-label={`Trade ${idx + 1}`}
                      placeholder="Trade (e.g. Mason)"
                      value={row.trade}
                      onChange={(e) => {
                        const next = [...manpowerRows];
                        next[idx] = { ...next[idx], trade: e.target.value };
                        setManpowerRows(next);
                      }}
                    />
                    <input
                      type="number"
                      min="0"
                      aria-label={`Count for trade ${idx + 1}`}
                      placeholder="Count"
                      value={row.count}
                      onChange={(e) => {
                        const next = [...manpowerRows];
                        next[idx] = { ...next[idx], count: e.target.value };
                        setManpowerRows(next);
                      }}
                    />
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      aria-label={`Hours for trade ${idx + 1}`}
                      placeholder="Hours"
                      value={row.hours}
                      onChange={(e) => {
                        const next = [...manpowerRows];
                        next[idx] = { ...next[idx], hours: e.target.value };
                        setManpowerRows(next);
                      }}
                    />
                    {manpowerRows.length > 1 && (
                      <button
                        type="button"
                        className="dpr-manpower-row-remove"
                        aria-label={`Remove trade ${idx + 1}`}
                        onClick={() => {
                          const next = manpowerRows.filter((_, i) => i !== idx);
                          setManpowerRows(next.length ? next : [{ trade: '', count: '', hours: '' }]);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {manpowerRows.length < MAX_MANPOWER_ROWS && (
                <button
                  type="button"
                  className="dpr-manpower-add"
                  onClick={() =>
                    setManpowerRows([...manpowerRows, { trade: '', count: '', hours: '' }])
                  }
                >
                  + Add trade
                </button>
              )}
              <div className="dpr-manpower-summary" aria-live="polite">
                {serializeManpowerRows(manpowerRows) || 'No trades added yet.'}
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                One trade per row. Trade name + count of workers + hours worked.
                Saved as &quot;Trade — Count — Hours&quot; (pipe-separated).
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="risksHindrances">
                Any risks
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <textarea
                id="risksHindrances"
                name="risksHindrances"
                className="form-input"
                rows={3}
                value={dailyFields.risksHindrances}
                onChange={handleDailyChange}
                placeholder="Heavy rain forecast 14:00 — slab pour may need to reschedule. Plastering at Villa 9 awaiting client shade approval."
                style={{ resize: 'vertical', minHeight: '80px' }}
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                Weather, labour, material, equipment, statutory, client — anything
                that could affect tomorrow's plan.
              </span>
            </div>

            <div className="form-group">
              <label htmlFor="materialsReceivedSummary">
                Any materials received
                <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
              </label>
              <textarea
                id="materialsReceivedSummary"
                name="materialsReceivedSummary"
                className="form-input"
                rows={2}
                value={dailyFields.materialsReceivedSummary}
                onChange={handleDailyChange}
                placeholder="OPC 53 cement — 50 bags (ACC); M-sand — 4 Cu.m (ABC quarry); 12 mm TMT — 1.2 MT (TATA)"
              />
              <span style={{ fontSize: '0.75rem', color: 'var(--steel)', marginTop: '0.25rem' }}>
                High-level rollup. Detailed material inspections go on the
                Inspection &amp; Compliance page.
              </span>
            </div>
          </fieldset>

          {/* Kept for backward-compat — generic notes catchall. */}
          <div className="form-group">
            <label htmlFor="notes">
              Other observations
              <span style={{ fontWeight: 400, color: 'var(--steel)' }}> (optional)</span>
            </label>
            <textarea
              id="notes"
              name="notes"
              className="form-input"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything else worth recording for this report..."
              style={{ resize: 'vertical', minHeight: '60px' }}
            />
          </div>
          </section>

          {/* A-11: section anchor — photo upload + preview grid. */}
          <section id="dpr-section-photos" className="dpr-form-section">
          {/* Photos */}
          <div className="form-group">
            <label>Site Photos (max {MAX_PHOTOS_PER_DPR})</label>
            {/* Round-17 B-14: photo previews via URL.createObjectURL — verified in
                handleFiles() (previewUrl stored on each photo + rendered in photo-grid below). */}
            <div
              className="photo-upload-zone"
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
              aria-label="Add photos"
            >
              <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
              <p>Drag &amp; drop photos or click to browse</p>
              <span>JPG, PNG, WebP — max {MAX_PHOTO_BYTES / 1024 / 1024}MB each</span>
            </div>
            <input ref={fileInputRef} type="file" accept={ACCEPTED_PHOTO_TYPES.join(',')} multiple style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />

            {photos.length > 0 && (
              <div className="photo-grid">
                {photos.map((photo, idx) => {
                  // SOL DR-005: server-draft hydration supplies `readUrl`
                  // (a short-lived SAS URL), while local picks carry
                  // `previewUrl` (an object URL). Rendering used to read
                  // only previewUrl, so a resumed live photo silently
                  // disappeared. Fall back to readUrl when the blob URL
                  // is gone, and surface an explicit "reattach" state
                  // when neither survives (e.g. SAS expired and the
                  // claim was deleted) instead of showing a broken
                  // image. The descriptor (ulid/container) is kept so
                  // Save still sends the row — only the preview is
                  // unavailable.
                  const previewSrc = photo.previewUrl || photo.readUrl || null;
                  return (
                    <div key={photo.ulid || idx} className="photo-thumb">
                      {previewSrc ? (
                        <img src={previewSrc} alt={photo.caption || 'Site photo'} />
                      ) : (
                        <div className="photo-thumb-unavailable" role="status" aria-label="Photo preview unavailable — re-attach to view">
                          Preview unavailable
                        </div>
                      )}
                      <button type="button" className="photo-remove" onClick={() => removePhoto(idx)} aria-label="Remove photo">×</button>
                      <input
                        className="photo-caption-input"
                        placeholder="Caption..."
                        value={photo.caption}
                        onChange={(e) => {
                          const updated = [...photos];
                          updated[idx] = { ...updated[idx], caption: e.target.value };
                          setPhotos(updated);
                        }}
                        aria-label="Photo caption"
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {Object.values(uploadStatuses).some((s) => s.status === 'uploading' || s.status === 'error') && (
              <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {Object.entries(uploadStatuses).map(([id, s]) =>
                  s.status === 'uploading' || s.status === 'error' ? (
                    <div
                      key={id}
                      style={{
                        fontSize: '0.8rem',
                        color: s.status === 'error' ? '#dc2626' : 'var(--steel)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <span>{s.status === 'uploading' ? '⏳' : '⚠️'}</span>
                      <span>{s.filename}</span>
                      {s.status === 'uploading' && <span>{s.progress}%</span>}
                      {s.status === 'error' && <span style={{ opacity: 0.85 }}>— {s.error}</span>}
                    </div>
                  ) : null
                )}
              </div>
            )}
          </div>
          </section>

          {/* A-11: section anchor — user-added ad-hoc text + tables. */}
          <section id="dpr-section-custom" className="dpr-form-section">
          {/* User-added ad-hoc sections (text + tables). */}
          <div style={{ marginTop: '1.5rem' }}>
            <DprCustomSection value={customSections} onChange={setCustomSections} />
          </div>
          </section>

          {/* A-11: section anchor — read-only summary of today's inspection records. */}
          <section id="dpr-section-inspections" className="dpr-form-section">
          {/* Today's inspection records summary card — links to the Inspection & Compliance page. */}
          <div
            className="dpr-card"
            style={{
              marginTop: '1.5rem',
              background: '#f8fafc',
              borderLeft: '3px solid var(--blue)',
            }}
          >
            <h3 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--navy)' }}>
              Today's Inspection &amp; Compliance Records
            </h3>
            {todayInspectionsLoaded && todayInspections.length === 0 ? (
              <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>
                None filed yet for {formatIndianDate(form.reportDate)}.
                {' '}
                <Link to={`/portal/inspection/submit?date=${form.reportDate}`}>
                  Create inspection record →
                </Link>
              </p>
            ) : !todayInspectionsLoaded ? (
              <p style={{ color: 'var(--steel)', fontSize: '0.9rem', margin: 0 }}>Loading…</p>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {todayInspections.slice(0, 5).map((insp) => (
                  <li key={insp.id} style={{ fontSize: '0.9rem' }}>
                    <Link to={`/portal/inspection/${insp.id}`}>{insp.inspectionType}</Link>
                    {' · '}
                    <span style={{ color: 'var(--steel)' }}>{insp.location}</span>
                    {' · '}
                    <span style={{ color: 'var(--steel)' }}>{insp.status}</span>
                  </li>
                ))}
                {todayInspections.length > 5 && (
                  <li style={{ color: 'var(--steel)', fontSize: '0.85rem' }}>
                    + {todayInspections.length - 5} more on the Inspection page.
                  </li>
                )}
                <li style={{ marginTop: '0.5rem' }}>
                  <Link to={`/portal/inspection/submit?date=${form.reportDate}`}>
                    + Create inspection record
                  </Link>
                </li>
              </ul>
            )}
          </div>
          </section>

          {editingId && (
            <div className="draft-banner" style={{ marginTop: '1rem' }}>
              {/* [DR-032] Same fix as the restored-draft banner — drop
                  the inline `flex: 1` so the stylesheet's `flex: 1 1 200px;
                  min-width: 0` contract applies at narrow widths. */}
              <span>
                ✏️ Editing saved draft. Changes will update the existing draft when you click Save or Submit.
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigate('/portal/dpr/my')}
                style={{ flexShrink: 0 }}
              >
                Cancel edit
              </button>
            </div>
          )}

          <div className="dpr-form-actions dpr-form-actions-sticky" style={{ marginTop: '1.5rem' }}>
            <button type="button" className="btn btn-secondary" onClick={() => handleSubmit('DRAFT')} disabled={status === 'submitting' || hasInFlightUploads}>
              {status === 'submitting' ? 'Saving...' : 'Save as Draft'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => handleSubmit('SUBMITTED')} disabled={status === 'submitting' || hasInFlightUploads}>
              {status === 'submitting' ? 'Submitting...' : hasInFlightUploads ? 'Waiting for photos…' : 'Submit Report'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
