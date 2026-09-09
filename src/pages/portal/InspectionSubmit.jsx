import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast } from '../../contexts/ToastContext.jsx';
import { api } from '../../lib/api.js';
import { uploadBlob } from '../../lib/blobUpload.js';
import {
  MAX_PHOTO_BYTES, MAX_PHOTOS_PER_DPR, ACCEPTED_PHOTO_TYPES,
} from '../../lib/constants.js';
import WorkEntryAdder from './WorkEntryAdder.jsx';
import FormProgress from '../../components/FormProgress.jsx';
import DrawingPicker from '../../components/DrawingPicker.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { getBusinessToday } from '../../lib/businessDate.js';
import { loadDiagnostic as loadScopedDraft, save as saveScopedDraft, clear as clearScopedDraft } from '../../lib/ownerScopedDraft.js';

const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rainy', 'Windy', 'Haze', 'Foggy'];
const DRAFT_BASE = 'inspection_draft_v1';
// SOL DR-001: bumped to v2 after a serializer bug dropped workEntry.data
// during autosave. v1 drafts (no __v, workEntry.data missing) are surfaced as
// "malformed" so the user can discard instead of crashing on reload.
const DRAFT_SCHEMA_VERSION = 2;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A-11: section skip-nav anchors. Keep in sync with the <section id>
// attributes below — used by the sticky in-form nav at the top of the page.
const INSPECTION_SECTIONS = [
  { id: 'inspection-section-site', label: 'Site Info' },
  { id: 'inspection-section-record', label: 'Inspection Record' },
  { id: 'inspection-section-photos', label: 'Photos' },
];

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

// SOL DR-003: the owner-scoped draft helpers wrap the raw localStorage
// access so the per-user scoping + one-time legacy migration stay in one
// place. The `loadDraft`/`saveDraft`/`clearDraft` wrappers below just
// thread the current employee id through.
function loadDraftForEmployee(employeeId) {
  // Diagnostic read so we can surface a malformed-draft banner when the
  // underlying localStorage entry exists but is unreadable. `load` alone
  // collapses "no draft" and "corrupt JSON" into the same null result,
  // which silently loses the user's data instead of telling them.
  const { value: raw, corrupt, quarantined } = loadScopedDraft(DRAFT_BASE, employeeId);
  if (corrupt) return { __malformed: true, reason: 'corrupt-storage' };
  if (raw === null) return null;
  // SOL DR-006: when the lib flags an envelope as quarantined, the
  // caller must NOT pre-fill the form — it might belong to a different
  // employee or be a legacy unscoped orphan. Surface the reason via a
  // dedicated sentinel so the banner can explain it (DR-006 acceptance
  // bullet: "missing/malformed owner information is not treated as
  // authorization").
  if (quarantined && raw && raw.__quarantined) {
    return { __quarantined: true, reason: raw.reason };
  }
  // SOL DR-001: detect v1 drafts that lost structured workEntry.data.
  // A well-formed v2 draft always has __v === 2 and, if workEntry is set,
  // includes a `data` object. Anything else is treated as malformed so the
  // user sees an explicit recover/discard banner instead of a crash on
  // render.
  if (!isObject(raw)) return { __malformed: true, reason: 'corrupt-shape' };
  const version = raw.__v;
  if (version !== DRAFT_SCHEMA_VERSION) {
    return { __malformed: true, reason: 'legacy-shape', payload: raw };
  }
  if (raw.workEntry !== null && raw.workEntry !== undefined) {
    if (!isObject(raw.workEntry) || !isObject(raw.workEntry.data)) {
      return { __malformed: true, reason: 'workentry-data-missing', payload: raw };
    }
  }
  return raw;
}

function saveDraftForEmployee(employeeId, payload) {
  const safe = {
    __v: DRAFT_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    form: payload.form,
    // SOL DR-001: previous serializer only kept `workType`, dropping the
    // structured field data the renderer needs (see render at lines ~473).
    // Persist the full entry — `data` is required for the inspection card
    // and for submit.
    workEntry: payload.workEntry
      ? {
          workType: payload.workEntry.workType,
          data: payload.workEntry.data || {},
          addedAt: payload.workEntry.addedAt || null,
        }
      : null,
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
      // rehydrated from a server-side draft. See DprSubmit.jsx for the
      // full rationale — the serializer just passes it through if
      // present so a reload can render the preview without refetching.
      ...(p.readUrl ? { readUrl: p.readUrl } : {}),
    })),
  };
  saveScopedDraft(DRAFT_BASE, employeeId, safe);
}

function clearDraftForEmployee(employeeId) {
  clearScopedDraft(DRAFT_BASE, employeeId);
}

// No-employee wrappers retained for the legacy `Discard` button which is
// triggered before the user explicitly clicks "new draft". In practice the
// component always has an employee id by the time the user reaches a
// working draft, but if a draft was loaded pre-login (it shouldn't be) we
// still want the explicit Discard path to wipe something.
function loadDraft() { return loadDraftForEmployee(null); }
function saveDraft() {/* no-op: never write an unscoped draft */}
function clearDraft() {/* no-op: never wipe an unscoped draft */}

export default function InspectionSubmit() {
  // SOL DR-007: when arriving via ?draftId=<id>, title reflects that
  // the engineer is editing an existing saved draft rather than
  // starting fresh. Mirrors DprSubmit.jsx#useDocumentTitle for
  // consistency across the two submit pages.
  const { accessToken, employee } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const draftId = searchParams.get('draftId') || null;
  useDocumentTitle(draftId ? 'Edit Draft · Inspection Record' : 'New Inspection / Compliance Record');
  const fileInputRef = useRef(null);
  const submittingRef = useRef(false);
  // S5 audit: per-field refs so validation failure can move focus to the
  // first invalid input (WCAG 3.3.1 — Error Identification). The form
  // has six inputs grouped in three sections; only the three that are
  // validated-on-submit (projectName, location, reportDate) + the
  // workEntry region need a ref for focus-to-first-invalid to work.
  const projectNameRef = useRef(null);
  const locationRef = useRef(null);
  const reportDateRef = useRef(null);
  const workEntryRef = useRef(null);

  // Optional dprId / reportDate in URL — when an engineer clicks "Create
  // inspection record" from the DPR summary card, we deep-link with both so
  // they don't have to re-pick the date.
  const queryDprId = searchParams.get('dpr') || null;
  const queryDate = searchParams.get('date') || null;

  // SOL DR-007: server-side draft resume (mirror DprSubmit.jsx's
  // editingId + editingVersion state). When set, the submit handler
  // routes Save-as-Draft through PUT /:id and Submit-Record through
  // POST /:id/submit instead of POST /.
  const [editingId, setEditingId] = useState(null);
  const [draftLoadedFromServer, setDraftLoadedFromServer] = useState(false);
  // SOL DR-007 (round-23): track the in-flight hydration separately from
  // the successfully-hydrated identity so a token rotation during the
  // GET — which cancels this effect and re-runs it — does NOT short-
  // circuit at the lastHydratedDraftIdRef guard and leave the form
  // stuck in create mode on a `?draftId=<id>` URL. Three modes:
  //   - 'idle'    — no draft URL or no fetch attempted yet
  //   - 'loading' — fetch is in-flight, writes must be blocked
  //   - 'loaded'  — identity (editingId) is hydrated from server
  //   - 'error'   — fetch failed; UI surfaces Retry
  // Saves/Submits on a draft URL refuse to proceed unless hydrationState
  // is 'loaded' — otherwise a half-typed replacement POST could land
  // while the original draft is still being read.
  const [hydrationState, setHydrationState] = useState('idle');
  const [hydrationError, setHydrationError] = useState(null);
  // SOL DR-006: defense-in-depth guard against the hydration effect
  // re-running when only its context deps change (toast push, token
  // rotation). See DprSubmit.jsx for the full rationale — the same
  // lastHydratedDraftIdRef pattern keeps dirty form state intact when
  // a sibling toast push or auth-context re-render fires after a
  // successful initial load.
  const lastHydratedDraftIdRef = useRef(null);
  // SOL DR-007 (round-23): monotonically-incrementing run id so a
  // cleanup-then-rehydrate race (token rotate during GET) can let the
  // original fetch complete cleanly AND let the next fetch start a
  // brand-new run that supersedes it. Mirrors DprSubmit.jsx.
  const hydrationRunIdRef = useRef(0);

  // Reusable YYYY-MM-DD normaliser. The backend serialises reportDate
  // as a Date that JSON.stringify renders as ISO datetime on some
  // versions; strip the time suffix so the <input type="date"> keeps
  // its value, falling back to today when the value is missing/invalid.
  function toYmd(value) {
    if (!value) return getLocalDate();
    if (typeof value === 'string') {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    const d = new Date(value);
    if (isNaN(d.getTime())) return getLocalDate();
    const y = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }

  // SOL DR-003: every draft read/write is keyed by employeeId. If the
  // auth context has not populated yet (very first render), we treat that
  // as "no draft" — once `employee` becomes truthy the autosave useEffect
  // below will pick it up on the next state change.
  const currentEmployeeId = employee && employee.id ? employee.id : null;

  // SOL DR-001: compute draft + malformed flag ONCE on mount via useState
  // initializers. A regular const would re-evaluate on every render, which
  // means after `clearDraft()` runs in a useEffect a later re-render would
  // see empty localStorage and silently drop the malformed banner. Pinning
  // the values to state preserves the user-visible recovery state across
  // subsequent renders and state updates.
  // SOL DR-006: also compute a quarantine flag — when the lib refuses to
  // surface the saved envelope because we cannot verify authorship, we
  // must NOT pre-fill the form. The form fields fall back to defaults
  // (see `d?.__quarantined || d?.__malformed` guards below) and a banner
  // is shown instead.
  const [malformedReason] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    return d?.__malformed ? d.reason : null;
  });
  const [quarantinedReason] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    return d?.__quarantined ? d.reason : null;
  });
  const [initialForm] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    if (d?.__malformed || d?.__quarantined || !d) {
      return {
        // [N1 Phase B] projectId is the new foreign-key; projectName
        // stays for legacy wire-compat. Both reset in lockstep.
        projectId: '',
        projectName: '',
        location: '',
        reportDate: queryDate || getLocalDate(),
        weather: '',
        contractor: '',
        // N7: optional BOQ link.
        boqItemId: '',
        // N3 (Phase F): optional drawing stamp (drawingId + drawingRev).
        drawingId: '',
        drawingRev: '',
      };
    }
    return d.form || {
      projectId: '',
      projectName: '',
      location: '',
      reportDate: queryDate || getLocalDate(),
      weather: '',
      contractor: '',
      boqItemId: '',
      // N3 (Phase F): optional drawing stamp.
      drawingId: '',
      drawingRev: '',
    };
  });
  const [initialWorkEntry] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    if (d?.__malformed || d?.__quarantined || !d) return null;
    return d.workEntry || null;
  });
  const [showDraftBannerInitial] = useState(() => {
    const d = loadDraftForEmployee(currentEmployeeId);
    return !d?.__malformed && !d?.__quarantined && !!d;
  });
  const [form, setForm] = useState(initialForm);
  const [workEntry, setWorkEntry] = useState(initialWorkEntry);
  const [photos, setPhotos] = useState(() => {
    // SOL DR-005: seed photos from the local-draft envelope so the 750ms
    // autosave that fires on first render cannot write `photos: []` over
    // a previously-saved list. Same malformed/quarantine guard the
    // form-state initializer uses. DprSubmit.jsx applies the identical
    // initializer — see that file for the full rationale.
    const d = loadDraftForEmployee(currentEmployeeId);
    if (d?.__malformed || d?.__quarantined || !d) return [];
    return Array.isArray(d.photos) ? d.photos : [];
  });
  const [status, setStatus] = useState('idle');
  // S5 audit: split single-string error into per-field + banner model.
  //   formError   — banner text for non-field errors (upload-in-flight,
  //                 toast duplicates, generic submit failures).
  //   fieldErrors — { projectName?, location?, reportDate?, workEntry? }
  //                 map; presence triggers `aria-invalid` + an inline
  //                 error div on the matching input + a clickable entry
  //                 in the top-level summary banner that focuses the
  //                 field. Cleared by `clearErrors()` at the start of
  //                 every submission attempt.
  const [formError, setFormError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [showDraftBanner, setShowDraftBanner] = useState(showDraftBannerInitial);
  const [uploadStatuses, setUploadStatuses] = useState({});
  const [prefillAttempted, setPrefillAttempted] = useState(false);
  // N7: BOQ items for the named project. Loaded debounced so we don't
  // fire a request per keystroke. Used by the BOQ selector below and
  // dropped if the project is renamed mid-form (selected id no longer
  // valid).
  const [boqItems, setBoqItems] = useState([]);
  const [boqItemsLoaded, setBoqItemsLoaded] = useState(false);
  // [N1 Phase B] project picker data — one-time fetch on mount, same
  // shape as the DPR submit dropdown. Drives the new project <select>;
  // see handleProjectChange for the lockstep projectId+projectName set.
  const [projects, setProjects] = useState([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  // [R34] Inline create-new-project flow. Same shape as DprSubmit +
  // DrawingsBrowse (Round-32): pick the `__create__` sentinel → name
  // input + Create button → calls api.resolveProject → merges the new
  // Project into the picker and selects it. Replaces the previous
  // "submit and hope the backend auto-creates" round-trip with a
  // visible affordance so field engineers can register a brand-new
  // project name from the form itself.
  const [createMode, setCreateMode] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [resolveError, setResolveError] = useState('');
  // [Bug fix] True while POST /api/projects/resolve is in flight after
  // the user picks a discovered (name-only) project row. Mirrors the
  // DprSubmit.jsx flag — see the comment there for the full rationale.
  const [resolvingProject, setResolvingProject] = useState(false);
  const photoObjectUrlsRef = useRef(new Set());

  // [DR-006 client] Live count of photos still going through the SAS / PUT
  // / confirm-upload pipeline. Submit is blocked while this is > 0 so a
  // record can never be created referencing an upload that hasn't reached
  // CONFIRMED yet. Re-evaluated on every render — cheap because uploadStatuses
  // is small and most entries settle to 'complete' / 'error' quickly.
  const hasInFlightUploads = useMemo(
    () => Object.values(uploadStatuses).some(
      (s) => s && (s.status === 'requesting-sas' || s.status === 'uploading' || s.status === 'confirming'),
    ),
    [uploadStatuses],
  );

  // On mount, clear any malformed legacy draft so we never show it again
  // and don't keep crashing the user on every reload.
  // SOL DR-006: also drop the quarantined value — we kept the envelope
  // around long enough to surface the banner, but we never want to
  // re-surface it (and we never want the next save() to silently
  // inherit someone else's owner stamp either).
  useEffect(() => {
    if (malformedReason && currentEmployeeId) clearDraftForEmployee(currentEmployeeId);
    if (quarantinedReason && currentEmployeeId) clearDraftForEmployee(currentEmployeeId);
  }, [malformedReason, quarantinedReason, currentEmployeeId]);

  // SOL DR-003: subscribe to logout / session-expiry and clear the current
  // user's draft so a Shared computer does not retain it.
  useEffect(() => {
    const handler = (e) => {
      const cleared = e && e.detail && e.detail.employeeId;
      if (!cleared || cleared !== currentEmployeeId) return;
      clearDraftForEmployee(cleared);
      setForm({
        projectName: '',
        location: '',
        reportDate: queryDate || getLocalDate(),
        weather: '',
        contractor: '',
        boqItemId: '',
        // N3 (Phase F): drop the drawing stamp on session-expiry too —
        // a shared computer shouldn't retain the previous user's pick.
        drawingId: '',
        drawingRev: '',
      });
      setWorkEntry(null);
      setPhotos([]);
      setShowDraftBanner(false);
    };
    window.addEventListener('draft:clear-current', handler);
    return () => window.removeEventListener('draft:clear-current', handler);
  }, [currentEmployeeId, queryDate]);

  // Best-effort pre-fill of project/location from the latest submitted DPR
  // today. Runs once. If no DPR exists for today, the engineer types the
  // values manually (matching the round-12 design — inspections can be
  // filed on holidays / Sundays where no DPR exists).
  useEffect(() => {
    if (prefillAttempted) return;
    if (form.projectName && form.location) {
      setPrefillAttempted(true);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const today = getLocalDate();
        const data = await api.getDprs({ from: today, to: today, limit: '1' }, accessToken);
        const latest = (data.dprs || [])[0];
        if (!cancelled && latest && !form.projectName) {
          setForm((f) => ({
            ...f,
            // [N1 Phase B] carry the projectId from the latest DPR if
            // the backend joined it; otherwise the user re-picks from
            // the dropdown. projectName is kept for the canonical
            // display + wire-compat.
            projectId: latest.projectId || (latest.project && latest.project.id) || f.projectId,
            projectName: latest.projectName || f.projectName,
            location: latest.location || f.location,
            contractor: latest.contractor || f.contractor,
            weather: latest.weather || f.weather,
          }));
        }
      } catch {
        // Non-fatal — engineer can type it.
      } finally {
        if (!cancelled) setPrefillAttempted(true);
      }
    })();
    return () => { cancelled = true; };
    // intentionally only on mount — the user can override the prefill fields
    // afterwards and we don't want to overwrite their edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // N7: load BOQ items for the named project (debounced). Same
  // shape as the DPR submit form — see DprSubmit.jsx for the
  // rationale on the debounce window and the "selected id survives a
  // rename" guard.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.projectName]);

  // Persist draft (debounced 750ms — matches DPR pattern at DprSubmit.jsx:124).
  useEffect(() => {
    // SOL DR-007: do not clobber an in-progress local draft when the
    // user is editing a server-side draft (editingId is set). The
    // server record is the source of truth once we're editing it;
    // mirroring it back to localStorage would race against the live
    // PUT /api/inspection/:id updates that the resumed-edit flow
    // performs.
    if (!currentEmployeeId || editingId) return;
    const t = setTimeout(
      () => saveDraftForEmployee(currentEmployeeId, { form, workEntry, photos }),
      750
    );
    return () => clearTimeout(t);
  }, [form, workEntry, photos, currentEmployeeId, editingId]);

  // SOL DR-007: when arriving via ?draftId=<id>, fetch the saved
  // server-side draft and pre-populate the form. Mirrors the equivalent
  // effect at DprSubmit.jsx:304 — same shape, inspection fields
  // instead of DPR. If the record is no longer DRAFT (admin moved it
  // to OPEN/ACKNOWLEDGED/etc.), navigate back to the list with a
  // warning instead of silently editing a row that can no longer be
  // PUT-touched.
  //
  // DR-007 (round-23): the previous implementation set a `cancelled`
  // flag from the cleanup callback and skipped ALL state application
  // when set — including the success path. A token rotation during
  // the GET cancelled the effect, the replacement re-ran and short-
  // circuited at `lastHydratedDraftIdRef === draftId`, and the form
  // was stuck in create mode on an explicit draft URL. The fix: use a
  // monotonic run-id (DprSubmit.jsx pattern) so the closure's results
  // apply when its run is still the latest, and surface a `loading` /
  // `error` mode so Save/Submit can refuse to proceed until the GET
  // settles. A Retry control resets the run so the user can recover
  // from a transient failure without a full page reload.
  useEffect(() => {
    if (!draftId || !accessToken) {
      setHydrationState('idle');
      return;
    }
    // SOL DR-006: skip re-hydration when only the toast/token
    // identity changes. We only re-run when the target draftId changes.
    if (lastHydratedDraftIdRef.current === draftId) return;
    // Mark in-flight BEFORE the await so a sibling re-render
    // (project picker resolving, today-inspections fetch etc.)
    // doesn't fire a second GET against the same row. Mirrors
    // DprSubmit.jsx — see comment there for the full rationale.
    lastHydratedDraftIdRef.current = draftId;
    const myRunId = ++hydrationRunIdRef.current;
    setHydrationState('loading');
    setHydrationError(null);
    (async () => {
      try {
        const d = await api.getInspection(draftId, accessToken);
        if (hydrationRunIdRef.current !== myRunId) return;
        if (d.status !== 'DRAFT') {
          toast.push(`This inspection is no longer a draft (status: ${d.status}).`, 'warning');
          navigate('/portal/inspection/my', { replace: true });
          lastHydratedDraftIdRef.current = null;
          setHydrationState('idle');
          return;
        }
        setEditingId(d.id);
        setForm({
          projectId: d.projectId || (d.project && d.project.id) || '',
          projectName: d.projectName || '',
          location: d.location || '',
          reportDate: toYmd(d.reportDate),
          weather: d.weather || '',
          contractor: d.contractor || '',
          boqItemId: d.boqItemId || '',
          drawingId: d.drawingId || '',
          drawingRev: d.drawingRev || '',
        });
        // workEntry on the wire = { inspectionType, data }. Persist the
        // structured fields verbatim so the renderer card shows the
        // engineer what they originally saved.
        if (d.data && (d.inspectionType || Object.keys(d.data).length > 0)) {
          setWorkEntry({
            workType: d.inspectionType || 'material_inspection',
            data: d.data || {},
            addedAt: null,
          });
        }
        // SOL DR-006: restore server-side photo references (ULIDs +
        // read URLs) into the local photos state. The previous
        // `setPhotos([])` after every resume dropped the prior
        // evidence chain on every server-side load and silently lost
        // any newly added photo the engineer had uploaded before the
        // resume. SAS read URLs are read-only — we keep them as
        // `readUrl` so the renderer can show a preview without a
        // local blob.
        //
        // SOL DR-004: mark server-loaded photos `persisted: true` so
        // the Submit handler only sends NEW additions. Without this
        // flag every Save would re-send the already-persisted photos
        // and the server's nested `photos: { create: [...] }` happily
        // duplicated each one. The flag is the additive semantic the
        // audit asked for: persisted rows are owned by the server,
        // additions are owned by the client, the two never collide.
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
        setHydrationState('loaded');
      } catch (err) {
        if (hydrationRunIdRef.current !== myRunId) return;
        const msg = err && err.message ? err.message : 'Failed to load draft';
        toast.push(msg, 'error');
        lastHydratedDraftIdRef.current = null;
        setHydrationState('error');
        setHydrationError(msg);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, accessToken, toast, navigate, hydrationNonce]);

  // [N1 Phase B] Project picker — one-time fetch on mount. Same shape
  // as the DprSubmit.jsx equivalent; defensive on failure so the form
  // still mounts even if /api/projects is temporarily down.
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
        // My Drawings (Round-30 + 32.1) + DprSubmit (R34).
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
        // Non-fatal — the dropdown renders its empty state and the
        // user can still pick via the typed-fallback.
      } finally {
        if (!cancelled) setProjectsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // Cleanup blob URLs on unmount.
  useEffect(() => {
    return () => {
      photoObjectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      photoObjectUrlsRef.current.clear();
    };
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  // [N1 Phase B + bug fix] Project picker change handler. Mirrors the
  // DprSubmit.jsx version — for discovered rows we call POST
  // /api/projects/resolve to promote the name to a real Project and
  // get a UUID BEFORE downstream pickers (DrawingPicker, BOQ refetch
  // keyed on projectId) fire. Registered rows take the synchronous
  // fast path. See backend/src/routes/projects.js POST /resolve for
  // the server side.
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
    if (!match) return; // defensive: stale option

    // Fast path: registered row already has a UUID.
    if (match.id) {
      setForm((f) => ({
        ...f,
        projectId: match.id,
        projectName: match.name,
        boqItemId: '',
        // N3 (Phase F): clear the drawing stamp when the project changes
        // so we never carry a stale drawingId/rev across sites.
        drawingId: '',
        drawingRev: '',
      }));
      return;
    }

    // Discovered row: promote to a real Project.
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
  // DprSubmit.jsx#handleCreateProject + DrawingsBrowse.jsx#
  // handleCreateProject: POST /api/projects/resolve returns the existing
  // Project (case-insensitive lookup) or creates one with
  // createdById=req.employeeId. On success: merge the row into the
  // picker + select it as the form's project. On error: surface a
  // friendly message (including PROJECT_INACTIVE for archived names).
  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name || resolvingProject) return;
    setResolvingProject(true);
    setResolveError('');
    try {
      const proj = await api.resolveProject(name, accessToken);
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
      setFormError(msg);
      toast.push(msg, 'warning');
      return;
    }
    if (photos.length + valid.length > MAX_PHOTOS_PER_DPR) {
      const msg = `Max ${MAX_PHOTOS_PER_DPR} photos allowed`;
      setFormError(msg);
      toast.push(msg, 'warning');
      return;
    }

    setFormError('');

    const completed = [];
    const failed = [];

    for (const file of valid) {
      const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const previewUrl = URL.createObjectURL(file);
      photoObjectUrlsRef.current.add(previewUrl);
      updateUploadStatus(tempId, { status: 'uploading', progress: 0, filename: file.name });

      try {
        const { sasUrl, ulid } = await api.getInspectionSasUrl(file.name, file.type, accessToken);
        updateUploadStatus(tempId, { status: 'uploading', progress: 0 });

        await uploadBlob(sasUrl, file, {
          contentType: file.type,
          onProgress: (pct) => updateUploadStatus(tempId, { status: 'uploading', progress: pct }),
        });

        await api.confirmInspectionUpload(ulid, file.name, file.type, file.size, accessToken);

        updateUploadStatus(tempId, { status: 'complete', progress: 100 });
        completed.push({
          ulid,
          container: 'inspection-photos',
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

  // S5 audit: per-field error rendering. Each validation branch sets the
  // field-level error (via `setFieldError(key, msg)`) which drives the
  // inline error message, the aria-invalid flag, and a clickable entry
  // in the top-level summary list. The first invalid field is also
  // focus'd + scrolled into view (WCAG 3.3.1 + 3.3.3).
  const clearErrors = useCallback(() => {
    setFormError('');
    setFieldErrors({});
  }, []);

  const setFieldError = useCallback((key, msg) => {
    setFieldErrors((prev) => ({ ...prev, [key]: msg }));
  }, []);

  const focusFirstInvalid = useCallback((errors) => {
    // Order matches the top-to-bottom layout of the form so the focus
    // move is predictable for users who tab through top-down.
    const order = ['projectName', 'location', 'reportDate', 'workEntry'];
    const first = order.find((k) => errors[k]);
    if (!first) return;
    const refMap = {
      projectName: projectNameRef,
      location: locationRef,
      reportDate: reportDateRef,
      workEntry: workEntryRef,
    };
    const node = refMap[first]?.current;
    if (node && typeof node.focus === 'function') {
      node.focus({ preventScroll: false });
      if (typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, []);

  const handleSubmit = async (submitStatus) => {
    if (submittingRef.current) return;
    submittingRef.current = true;

    // SOL DR-007 (round-23): refuse to write on a draft URL until the
    // server-side draft has finished hydrating. Without this guard, a
    // fast click on Save while the GET is still in-flight would race:
    //   - editingId is still null (hydration hasn't set it yet)
    //   - the handler falls through to `createInspection` (POST /)
    //   - the user ends up with a brand-new record on top of the one
    //     they explicitly asked to Resume.
    // Also block on hydration failure so the user must explicitly
    // Retry rather than get a silent second POST. Mirror guard goes
    // on DprSubmit.jsx for symmetry.
    if (draftId && hydrationState === 'loading') {
      submittingRef.current = false;
      const msg = 'Loading the saved draft — please wait a moment before saving.';
      setFormError(msg);
      toast.push(msg, 'warning');
      return;
    }
    if (draftId && hydrationState === 'error') {
      submittingRef.current = false;
      const msg = 'Could not load the saved draft. Please retry loading before saving.';
      setFormError(msg);
      toast.push(msg, 'warning');
      return;
    }

    clearErrors();
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
      setFormError(msg);
      toast.push(msg, 'warning');
      submittingRef.current = false;
      return;
    }
    // N-4: validation depends on submit intent. DRAFT is "save for
    // later" — it should accept the barest bones (just a project name)
    // so an employee can capture half a record between meetings.
    // OPEN (final Submit) keeps the strict contract: project + location
    // + date + at least one structured workEntry.
    const isDraftSave = submitStatus === 'DRAFT';

    const newFieldErrors = {};
    if (!form.projectName) newFieldErrors.projectName = 'Project name is required';
    if (!isDraftSave) {
      if (!form.location)    newFieldErrors.location    = 'Location is required';
      if (!form.reportDate)  newFieldErrors.reportDate  = 'Date is required';
    }
    if (Object.keys(newFieldErrors).length > 0) {
      setFieldErrors(newFieldErrors);
      setFormError(isDraftSave
        ? 'Add a project name before saving a draft.'
        : 'Please fix the highlighted fields and try again.');
      toast.push(isDraftSave
        ? 'Add a project name before saving a draft.'
        : 'Please fill in the highlighted fields.', 'warning');
      focusFirstInvalid(newFieldErrors);
      submittingRef.current = false;
      return;
    }
    if (!isDraftSave && !workEntry) {
      setFieldError('workEntry', 'Please add an inspection record before submitting');
      setFormError('Please fix the highlighted fields and try again.');
      toast.push('Please add an inspection record before submitting.', 'warning');
      focusFirstInvalid({ workEntry: true });
      submittingRef.current = false;
      return;
    }
    // SOL DR-001: belt-and-braces — refuse to submit a workEntry whose
    // structured data has been lost. A correct serializer keeps `data` intact,
    // so reaching this branch means the in-memory draft was constructed
    // unsafely. Skip for DRAFT since workEntry can legitimately be null.
    if (!isDraftSave && (!workEntry.data || typeof workEntry.data !== 'object')) {
      const msg = 'This inspection record is missing its structured fields. Please re-add the record before submitting.';
      setFieldError('workEntry', msg);
      setFormError(msg);
      toast.push(msg, 'warning');
      focusFirstInvalid({ workEntry: true });
      submittingRef.current = false;
      return;
    }
    // Date sanity-check still applies to DRAFT if a date was entered —
    // an invalid date string should not be persisted at all.
    if (form.reportDate) {
      const dateErr = validateReportDate(form.reportDate);
      if (dateErr) {
        setFieldError('reportDate', dateErr);
        setFormError(dateErr);
        toast.push(dateErr, 'warning');
        focusFirstInvalid({ reportDate: dateErr });
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

      // SOL DR-007: when editing an existing server-side draft the
      // publish transition can't ride a single PUT — the backend's
      // mass-assignment allowlist deliberately excludes `status`
      // (mirrors DprSubmit.jsx + dpr.js after DR-003). Branch on the
      // submit intent: DRAFT keeps the PUT, SUBMITTED first PUTs the
      // edit (so the latest structured fields land) then calls
      // POST /:id/submit which transitions DRAFT → OPEN. The same
      // helper shape as DprSubmit.jsx:925-948 — keep the per-record
      // contract symmetric across the two submit pages.
      if (editingId) {
        const editPayload = {
          projectId: form.projectId || null,
          projectName: form.projectName,
          location: form.location || (isDraftSave ? 'TBD' : ''),
          reportDate: form.reportDate || (isDraftSave ? getBusinessToday() : null),
          weather: form.weather || null,
          contractor: form.contractor || null,
          dprId: queryDprId || null,
          inspectionType: workEntry?.workType || 'material_inspection',
          data: workEntry?.data || null,
          boqItemId: form.boqItemId || null,
          drawingId: form.drawingId || null,
          drawingRev: form.drawingRev || null,
          severity: null,
          // SOL DR-004: include `photos` on PUT so newly-added evidence
          // lands on a resumed edit. The previous inline literal omitted
          // this field, so additions were silently dropped on every
          // resumed edit and the server never saw them — the exact
          // "Inspection resume computes new photo claims but omits them
          // from PUT" path the audit flagged. Additive only: the
          // server-side dedupe filters out any ulid already on the
          // record, and the client's `persisted` filter above keeps
          // previously-saved rows out of the payload entirely.
          photos: photosToSubmit,
        };
        // PUT first so the latest structured fields land on the row.
        // Then for SUBMITTED, call the dedicated publish endpoint —
        // the response carries the row in its terminal OPEN state so
        // we can show the same success path as a fresh submit.
        await api.updateInspection(editingId, editPayload, null, accessToken);
        if (submitStatus === 'SUBMITTED') {
          const submitted = await api.submitInspection(editingId, accessToken);
          if (submitted && submitted.status === 'OPEN') {
            // SOL DR-004: acknowledge the photos we just sent so the
            // additive flag flips and any subsequent edit treats them
            // as already persisted. Same keying as the Save branch.
            markPhotosPersisted(photosToSubmit);
            toast.push('Inspection record submitted.', 'success');
            navigate('/portal/inspection/my');
          } else {
            toast.push('Submit did not complete. Please refresh and try again.', 'error');
            setStatus('idle');
            submittingRef.current = false;
            return;
          }
        } else {
          // SOL DR-004: acknowledge the photos we just sent so the
          // additive flag flips and any subsequent edit treats them
          // as already persisted.
          markPhotosPersisted(photosToSubmit);
          toast.push('Draft updated.', 'success');
          navigate('/portal/inspection/my');
        }
        return;
      }

      // DR-012: mint a fresh idempotency key per submit intent. The
      // backend stores (employeeId, Idempotency-Key, bodyHash) → 201
      // for 5 minutes so a NETWORK_ERROR retry (api.js:168-178) replays
      // the same key + body and returns the cached row instead of
      // creating a duplicate inspection + duplicate admin notification
      // email. Submitting twice intentionally must mint TWO keys (a
      // second submit click is a fresh user intent, not a retry).
      const idempotencyKey = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : `insp-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      await api.createInspection(
        {
          // [N1 Phase B] projectId is the new foreign-key; projectName
          // is kept for legacy-compat. Both come from form state — set
          // atomically by handleProjectChange.
          projectId: form.projectId || null,
          projectName: form.projectName,
          // N-4: DRAFT can be saved with bare-bones fields. The schema
          // requires non-null `location`/`reportDate`/`inspectionType`,
          // so when the user hasn't filled them in we substitute the
          // same default the resume flow would otherwise need them to
          // add before they could save at all. `reportDate` falls back
          // to today (IST business day) so the draft always sits on a
          // valid calendar bucket.
          location: form.location || (isDraftSave ? 'TBD' : ''),
          reportDate: form.reportDate || (isDraftSave ? getBusinessToday() : null),
          weather: form.weather || null,
          contractor: form.contractor || null,
          dprId: queryDprId || null,
          // `inspectionType` has a non-null DB constraint. For an OPEN
          // row we already refuse to send without workEntry. For DRAFT
          // we default to `material_inspection` (the most common entry)
          // so the user can save now and change it on Resume; the data
          // object stays null because there is no structured entry yet.
          inspectionType: workEntry?.workType || 'material_inspection',
          data: workEntry?.data || null,
          // N7: optional BOQ link. null when unset.
          boqItemId: form.boqItemId || null,
          // N3 (Phase F): optional drawing stamp — drawingId (UUID) +
          // drawingRev (denormalised revision string). Both null when
          // unset so the backend skips the join.
          drawingId: form.drawingId || null,
          drawingRev: form.drawingRev || null,
          // SOL DR-005: the two buttons finally diverge. "Save as Draft"
          // stores an owner-visible DRAFT row that does NOT trigger admin
          // fan-out (backend/src/routes/inspection.js ALLOWED_STATUSES).
          // "Submit Record" creates an OPEN row as before. Previously
          // both routes sent 'OPEN', so "Save as Draft" silently
          // published into the admin review queue.
          status: submitStatus === 'DRAFT' ? 'DRAFT' : 'OPEN',
          // Round-12 MVP: severity is not asked at submit time. The
          // Inspection page surfaces it on the detail view for NCR / safety
          // sub-types where the structured data already implies severity
          // (e.g. `severity` field in the NCR / safety_violation schema).
          severity: null,
          photos: photosToSubmit,
        },
        accessToken,
        idempotencyKey
      );

      clearDraftForEmployee(currentEmployeeId);
      toast.push(submitStatus === 'DRAFT' ? 'Draft saved.' : 'Inspection record submitted.', 'success');
      navigate('/portal/inspection/my');
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
        : (err.message || 'Failed to submit inspection record');
      setFormError(msg);
      setStatus('idle');
      if (err.status !== 401) toast.push(msg, 'error');
    } finally {
      submittingRef.current = false;
    }
  };

  const handleDiscardDraft = () => {
    // SOL DR-007 (round-23): "Discard / start fresh" clears the edit
    // identity, version, and URL `?draftId=<id>` so the next Save
    // creates a fresh POST instead of overwriting the original draft
    // via PUT. The audit's exact wording: "start fresh clears edit
    // identity/version/query/claims/pending work while preserving the
    // old saved row". We preserve the saved row server-side — we only
    // detach the local edit session from it.
    const wasEditingServerDraft = Boolean(editingId);
    clearDraftForEmployee(currentEmployeeId);
    setForm({
      // [N1 Phase B] reset projectId + projectName in lockstep.
      projectId: '',
      projectName: '',
      location: '',
      reportDate: queryDate || getLocalDate(),
      weather: '',
      contractor: '',
      boqItemId: '',
      // N3 (Phase F): drop the drawing stamp too.
      drawingId: '',
      drawingRev: '',
    });
    setWorkEntry(null);
    setPhotos([]);
    setShowDraftBanner(false);
    if (wasEditingServerDraft) {
      // Detach from the server-side draft — next Save must POST /api/inspection,
      // not PUT /api/inspection/:editingId. Also invalidate the
      // hydration guard so a future navigation back to the same URL
      // re-fetches (matches DPR's discard-then-revert behaviour).
      setEditingId(null);
      setDraftLoadedFromServer(false);
      lastHydratedDraftIdRef.current = null;
      // Drop the `?draftId=<id>` query so the URL no longer claims
      // we're editing that row. Keep any `?dpr=` / `?date=` deep-link
      // parameters intact so the engineer doesn't lose them.
      if (draftId) {
        const next = new URLSearchParams(searchParams);
        next.delete('draftId');
        setSearchParams(next, { replace: true });
      }
    }
    toast.push('Draft discarded.', 'info');
  };

  // SOL DR-007 (round-23): the hydration effect can land in 'error' on a
  // transient server/network failure. Without an explicit Retry the user
  // would have to refresh the whole page (losing in-progress form state)
  // or navigate away and back. The hydration effect re-runs whenever
  // `hydrationNonce` changes; Retry bumps it. The nonce is the only
  // safe dep-add — swapping `draftId` would re-mount the form, and
  // `accessToken` rotation is already the bug we're guarding against.
  const [hydrationNonce, setHydrationNonce] = useState(0);
  const handleRetryHydration = () => {
    lastHydratedDraftIdRef.current = null;
    setHydrationError(null);
    setHydrationState('loading');
    setHydrationNonce((n) => n + 1);
  };

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <h1 className="dpr-page-title">New Inspection / Compliance Record</h1>
        <p style={{ color: 'var(--steel)', marginBottom: '1rem', fontSize: '0.9rem' }}>
          File a structured inspection record — material receipt, water
          quality, waterproofing, NCR, safety violation, etc. One record per submission.
        </p>

        {/* SOL-P1#11: progressive-disclosure progress strip — mirrors the
            DPR form so users see how many of the three sections they've
            filled before they can hit Submit. */}
        <FormProgress
          label="Inspection completion"
          sections={[
            {
              id: 'inspection-section-site',
              label: INSPECTION_SECTIONS[0].label,
              complete: Boolean(form.projectName && form.location && form.reportDate),
            },
            {
              id: 'inspection-section-record',
              label: INSPECTION_SECTIONS[1].label,
              complete: Boolean(workEntry && workEntry.workType),
            },
            {
              id: 'inspection-section-photos',
              label: INSPECTION_SECTIONS[2].label,
              complete: photos.length > 0,
            },
          ]}
        />

        {showDraftBanner && (
          <div
            role="status"
            className="draft-banner"
          >
            <span style={{ flex: 1 }}>📝 Restored unsaved draft from your previous visit.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowDraftBanner(false)}>
              Dismiss
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleDiscardDraft}>
              Discard
            </button>
          </div>
        )}

        {/* SOL DR-001: an older draft saved before the serializer fix has lost
            its structured workEntry.data. We cannot restore those fields, but
            we also must not crash the page or pretend the work is preserved. */}
        {malformedReason && (
          <div
            role="alert"
            className="portal-auth-error"
            style={{ marginBottom: '1rem' }}
          >
            <strong>We couldn't restore your previous draft.</strong>
            <p style={{ margin: '0.5rem 0 0 0' }}>
              A saved draft from a previous visit was found, but its structured
              fields could not be recovered. Your uploaded photos are no longer
              attached. Start a new entry below — your entries are not lost from
              reports you already submitted.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ marginTop: '0.75rem' }}
              onClick={handleDiscardDraft}
            >
              Discard old draft and start fresh
            </button>
          </div>
        )}

        {/* SOL DR-006: an orphaned / unowned local draft was found. We
            cannot prove authorship, so the form is NOT pre-filled — we
            surface an explicit banner explaining why the draft cannot
            be restored and offer a Discard affordance. */}
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

        {/* S5 audit: replaced the single banner with a structured error
            summary that lists every invalid field as a clickable link
            which focuses + scrolls the corresponding input (WCAG 3.3.1
            Error Identification + 3.3.3 Error Suggestion). The summary
            only appears when at least one field-level error exists; the
            plain banner remains for non-field failures (e.g. an upload
            in flight, or a 409 PHOTO_BINDING_LOST). */}
        {(() => {
          const errKeys = Object.keys(fieldErrors).filter((k) => fieldErrors[k]);
          if (errKeys.length === 0 && !formError) return null;
          const FIELD_LABELS = {
            projectName: 'Project name',
            location: 'Location',
            reportDate: 'Date',
            workEntry: 'Inspection record',
          };
          // Order matches the focusFirstInvalid order so the listed
          // links descend the same path as Tab navigation would.
          const orderedKeys = ['projectName', 'location', 'reportDate', 'workEntry']
            .filter((k) => errKeys.includes(k));
          return (
            <div
              id="inspection-form-error-summary"
              role="alert"
              aria-live="polite"
              className="portal-auth-error inspection-form-summary"
              style={{ marginBottom: '1rem' }}
            >
              <strong>
                {formError || 'Please fix the highlighted fields and try again.'}
              </strong>
              {orderedKeys.length > 0 && (
                <ul className="inspection-form-summary-list">
                  {orderedKeys.map((k) => (
                    <li key={k}>
                      <button
                        type="button"
                        className="inspection-form-summary-link"
                        onClick={() => focusFirstInvalid({ [k]: true })}
                      >
                        {FIELD_LABELS[k] || k}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}

        <div className="dpr-form">
          {/* A-11: section anchor — see INSPECTION_SECTIONS for the matching skip-nav target. */}
          <section id="inspection-section-site" className="dpr-form-section">
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
                  ref={projectNameRef}
                  className={`form-input${fieldErrors.projectName ? ' form-input-invalid' : ''}`}
                  // [Bug fix] Disable while POST /api/projects/resolve
                  // is in flight so a second click can't race against
                  // the optimistic setProjects swap.
                  disabled={resolvingProject}
                  // [R34] When in create-mode the select shows the
                  // `__create__` sentinel so the user sees where they
                  // are after picking "+ Create new project…".
                  value={createMode ? '__create__' : (() => {
                    if (form.projectId) return form.projectId;
                    if (form.projectName) {
                      const match = projects.find((p) => p.name === form.projectName);
                      return (match?.id) || form.projectName;
                    }
                    return '';
                  })()}
                  onChange={handleProjectChange}
                  aria-invalid={fieldErrors.projectName ? 'true' : 'false'}
                  aria-describedby={fieldErrors.projectName ? 'projectName-error' : undefined}
                  aria-busy={resolvingProject}
                >
                  <option value="">— Select a project —</option>
                  {projects.map((p) => (
                    <option key={p.id || p.name} value={p.id || p.name}>
                      {p.name}{p.code ? ` (${p.code})` : ''}{!p.isRegistered ? ' · auto-discovered' : ''}
                    </option>
                  ))}
                  {/* [R34] Sentinel + create-mode affordance — mirrors
                      DprSubmit.jsx + DrawingsBrowse.jsx. Always visible
                      (after the real projects) so a field engineer with
                      zero curated projects can still file an Inspection
                      against a brand-new site name without dropping to a
                      "type it in and submit anyway" workaround. */}
                  <option value="__create__">+ Create new project…</option>
                </select>
              )}
              {fieldErrors.projectName && (
                <div id="projectName-error" className="form-field-error" role="alert">
                  {fieldErrors.projectName}
                </div>
              )}
              {/* [R34] Inline create-new-project form. Mirrors
                  DprSubmit.jsx + DrawingsBrowse.jsx — name input +
                  Create/Cancel buttons that call api.resolveProject via
                  handleCreateProject. Escape cancels, Enter submits. */}
              {createMode && (
                <div
                  className="inspection-create-project"
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
                      htmlFor="inspection-new-project-name"
                      style={{ fontSize: '0.8rem', color: 'var(--steel)' }}
                    >
                      New project name
                    </label>
                    <input
                      id="inspection-new-project-name"
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
              <label htmlFor="reportDate">Report Date *</label>
              <input
                id="reportDate"
                ref={reportDateRef}
                type="date"
                name="reportDate"
                className={`form-input${fieldErrors.reportDate ? ' form-input-invalid' : ''}`}
                value={form.reportDate}
                onChange={handleChange}
                aria-invalid={fieldErrors.reportDate ? 'true' : 'false'}
                aria-describedby={fieldErrors.reportDate ? 'reportDate-error' : undefined}
              />
              {fieldErrors.reportDate && (
                <div id="reportDate-error" className="form-field-error" role="alert">
                  {fieldErrors.reportDate}
                </div>
              )}
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="location">Location *</label>
            <input
              id="location"
              ref={locationRef}
              name="location"
              className={`form-input${fieldErrors.location ? ' form-input-invalid' : ''}`}
              value={form.location}
              onChange={handleChange}
              aria-invalid={fieldErrors.location ? 'true' : 'false'}
              aria-describedby={fieldErrors.location ? 'location-error' : undefined}
              placeholder="Site address or location description"
            />
            {fieldErrors.location && (
              <div id="location-error" className="form-field-error" role="alert">
                {fieldErrors.location}
              </div>
            )}
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="weather">Weather</label>
              <select id="weather" name="weather" className="form-input" value={form.weather} onChange={handleChange}>
                <option value="">—</option>
                {WEATHER_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="contractor">Contractor</label>
              <input
                id="contractor"
                name="contractor"
                className="form-input"
                value={form.contractor}
                onChange={handleChange}
                placeholder="Contractor name"
              />
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
              Stamp this inspection against a specific drawing revision. Ask
              the design lead to add drawings in the Drawings Register
              if none are listed.
            </span>
          </div>

          {/* N7: optional BOQ link. Same UX as the DPR form — disabled
              until a project is named; the list re-fetches on debounced
              projectName change. "No BOQ items" gets an admin shortcut
              into the registry. */}
          <div className="form-group">
            <label htmlFor="boqItemId">BOQ Item Link (optional)</label>
            {(() => {
              const trimmedProject = (form.projectName || '').trim();
              if (!trimmedProject) {
                return (
                  <select id="boqItemId" className="form-input" disabled aria-disabled="true">
                    {/* BUG-3 (round-37): placeholder-as-real-value. `value=""`
                        makes the option truly empty (no fake "name a
                        project" string in the wire payload); `disabled`
                        greys it out so a real BOQ item can't re-select
                        the placeholder. */}
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
          </section>

          {/* A-11: section anchor — structured inspection record adder. */}
          <section id="inspection-section-record" className="dpr-form-section">
          <div className="form-group">
            <label>Inspection Record *</label>
            <div
              ref={workEntryRef}
              tabIndex={-1}
              role="group"
              aria-labelledby="inspection-record-error"
              aria-invalid={fieldErrors.workEntry ? 'true' : 'false'}
            />
            {fieldErrors.workEntry && (
              <div id="inspection-record-error" className="form-field-error" role="alert">
                {fieldErrors.workEntry}
              </div>
            )}
            {workEntry && workEntry.data && (
              <div className="work-entries-list">
                <div className="work-entry-card">
                  <div className="work-entry-card-header">
                    <span className="work-entry-card-title">{workEntry.workType}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setWorkEntry(null)}
                      aria-label="Remove inspection record"
                    >×</button>
                  </div>
                  <div className="work-entry-card-body">
                    {Object.entries(workEntry.data).slice(0, 4).map(([key, val]) => (
                      <div key={key} className="work-entry-card-field">
                        <span className="work-entry-card-label">{key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase())}:</span>
                        <span className="work-entry-card-value">{Array.isArray(val) ? val.join(', ') : String(val)}</span>
                      </div>
                    ))}
                    {Object.keys(workEntry.data).length > 4 && (
                      <span className="work-entry-card-more">+ {Object.keys(workEntry.data).length - 4} more fields</span>
                    )}
                  </div>
                </div>
              </div>
            )}
            {!workEntry && <WorkEntryAdder onAdd={setWorkEntry} sectionLabel="Add Inspection Record" submitLabel="Add Inspection Record" />}
          </div>
          </section>

          {/* A-11: section anchor — photo upload + preview grid. */}
          <section id="inspection-section-photos" className="dpr-form-section">
          <div className="form-group">
            <label>Photos (max {MAX_PHOTOS_PER_DPR})</label>
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
                  // unavailable. DprSubmit.jsx applies the same fix.
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

          {/* SOL DR-007: when the user reopened a saved DRAFT draft via
              Resume, the form fields are pre-filled with values cached
              from their previous submit. Without this hint the user
              might file a duplicate against the wrong date. Mirrors
              the editing banner on DprSubmit.jsx:1800 — same AA-compliant
              palette and round-37 mobile-wrap fix as `showDraftBanner`.
              Only shows when `editingId` is set; the load effect above
              already enforced `d.status === 'DRAFT'` before setting
              `editingId`, so `editingId` alone is sufficient. */}
          {editingId && (
            <div className="draft-banner" style={{ marginTop: '1rem' }}>
              <span style={{ flex: 1 }}>
                ✏️ Editing saved draft. Changes will update the existing draft when you click Save or Submit.
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigate('/portal/inspection/my')}
                style={{ flexShrink: 0 }}
              >
                Cancel edit
              </button>
            </div>
          )}

          {/* SOL DR-007 (round-23): persistent error banner on hydration
              failure. The toast push fires-and-forgets — a user who
              navigated past the toast would have no way to know the
              draft never loaded. Save/Submit are also blocked above
              (see handleSubmit guard) so this banner is the only signal
              the user has that the form is currently in a non-editable
              state. */}
          {draftId && hydrationState === 'error' && (
            <div
              className="draft-banner"
              style={{ marginTop: '1rem', background: '#fef2f2', borderColor: '#fca5a5', color: '#991b1b' }}
              role="alert"
              data-testid="dr007-hydration-error"
            >
              <span style={{ flex: 1 }}>
                ⚠️ Could not load the saved draft{hydrationError ? `: ${hydrationError}` : ''}. Save and Submit are disabled until the draft loads.
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleRetryHydration}
                style={{ flexShrink: 0 }}
              >
                Retry
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleDiscardDraft}
                style={{ flexShrink: 0 }}
              >
                Start fresh
              </button>
            </div>
          )}

          <div className="dpr-form-actions dpr-form-actions-sticky">
            <button type="button" className="btn btn-secondary" onClick={() => handleSubmit('DRAFT')} disabled={status === 'submitting' || hasInFlightUploads || (draftId && hydrationState === 'loading')}>
              {status === 'submitting' ? 'Saving...' : draftId && hydrationState === 'loading' ? 'Loading draft…' : editingId ? 'Save changes' : 'Save as Draft'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => handleSubmit('SUBMITTED')} disabled={status === 'submitting' || hasInFlightUploads || (draftId && hydrationState === 'loading')}>
              {status === 'submitting' ? 'Submitting...' : hasInFlightUploads ? 'Waiting for photos…' : draftId && hydrationState === 'loading' ? 'Loading draft…' : editingId ? 'Submit Draft' : 'Submit Record'}
            </button>
            {/* SOL DR-007 (round-23): explicit Retry on hydration failure.
                Saves/Submits are blocked on 'error' state until the user
                either retries (this button) or navigates away. Without
                this control, a transient GET failure would strand the
                form permanently until a full page reload. */}
            {draftId && hydrationState === 'error' && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleRetryHydration}
                data-testid="dr007-retry-hydration"
              >
                Retry loading draft
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
