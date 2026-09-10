/**
 * DR-019 (audit, 2026-09-08) — frontend pagination source-text pins.
 *
 * Pins the minimum-viable frontend fixes for DR-019:
 *
 *   1. BoqAdmin renders a "Load more" button when `hasMore` is true.
 *      The `loadMoreItems` walker existed before the audit but the JSX
 *      never called it; a BOQ table with >100 rows was unreachable from
 *      the UI.
 *
 *   2. ProjectExpandedPanel:
 *      - The `fetchAllAttachments` walker forwards a server-side `type`
 *        filter (when `filterType` is set) so the walker doesn't walk
 *        the first 200 rows of mixed types and then locally claim
 *        "no X-type reports" for X-type rows that lived past row 200.
 *      - The walker exposes `exhausted` so the UI knows whether to
 *        render "Load more".
 *      - The parent's effect re-fires when `reportsFilterType` changes
 *        (lifting filterType from ReportSection was the smallest
 *        containment).
 *      - The walker resets `filterType` when `projectKey` changes.
 *      - `loadMoreReports` calls `fetchAllAttachments` with the
 *        current `filterType` so a multi-page load keeps the chip.
 *
 * All checks are source-text pin tests (deterministic, run in <1ms)
 * so they don't pay the cost of mounting the actual components.
 */
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const panelPath = resolvePath(__dirname, '../pages/portal/ProjectExpandedPanel.jsx');
const boqAdminPath = resolvePath(__dirname, '../pages/admin/BoqAdmin.jsx');

const panelSource = readFileSync(panelPath, 'utf8');
const boqAdminSource = readFileSync(boqAdminPath, 'utf8');

describe('DR-019 — frontend pagination source-text pins', () => {
  describe('BoqAdmin.jsx — Load more button is rendered', () => {
    it('renders a button with the "Load more" label when hasMore is true', () => {
      // The button only renders when hasMore is true; pin both the
      // gate and the affordance text. The label toggles between
      // "Loading…" and "Load more" via a ternary — match the source
      // literal.
      expect(boqAdminSource).toMatch(/\{hasMore\s*&&\s*\(/);
      expect(boqAdminSource).toMatch(/'Load more'/);
    });

    it('the button calls loadMoreItems on click', () => {
      expect(boqAdminSource).toMatch(/onClick=\{loadMoreItems\}/);
    });

    it('has aria-label for screen readers', () => {
      // Accessibility pin — the button has a meaningful label so a
      // screen reader user knows what the affordance does.
      expect(boqAdminSource).toMatch(/aria-label="Load more BOQ items"/);
    });

    it('disables the button when loadMoreItems is in flight', () => {
      expect(boqAdminSource).toMatch(/disabled=\{loadingMore\s*\|\|\s*!nextCursor\}/);
    });
  });

  describe('ProjectExpandedPanel.jsx — server-side type filter', () => {
    it('fetchAllAttachments forwards a `type` query param when supplied', () => {
      // The walker must put the filter on the wire so the backend's
      // ?type= handler narrows the rows server-side. Without this, a
      // project with 500 monthly + 1 weekly walks the first 200
      // monthly rows and reports "no WEEKLY reports".
      expect(panelSource).toMatch(/if\s*\(typeFilter\)\s*params\.type\s*=\s*typeFilter/);
    });

    it('fetchAllAttachments returns { rows, exhausted } so the UI knows when more pages exist', () => {
      // The walker must report exhaustion so a project with >200
      // matching rows can render a "Load more" affordance.
      expect(panelSource).toMatch(/return\s*\{\s*rows:\s*collected\.slice\(0,\s*cap\),\s*exhausted\s*\}/);
    });

    it("parent's initial fetch effect depends on reportsFilterType", () => {
      // The parent must re-fire fetchAllAttachments when the chip
      // changes — without this dep, the chip is decorative (it'd
      // filter locally and still report "no X reports" past row 200).
      expect(panelSource).toMatch(/useEffect[\s\S]*?fetchAllAttachments[\s\S]*?\[projectKey,\s*isRegistered,\s*projectName,\s*accessToken,\s*reportsFilterType\]/);
    });

    it('parent resets filterType to null when projectKey changes', () => {
      // A half-set chip from a previous accordion card must not carry
      // over. The reset lives on the parent because filterType was
      // lifted out of ReportSection.
      expect(panelSource).toMatch(/useEffect\([\s\S]*?setReportsFilterType\(null\)[\s\S]*?\,\s*\[projectKey\]\)/);
    });

    it('loadMoreReports preserves the active filterType', () => {
      // Walk-one-more-page must keep the chip. Pin the dep so a
      // future refactor can't drop it silently.
      expect(panelSource).toMatch(/loadMoreReports[\s\S]*?reportsFilterType[\s\S]*?\}/);
    });

    it('render the Load more button in ReportSection when hasMore is true', () => {
      // The button only renders when hasMore is true.
      expect(panelSource).toMatch(/\{hasMore\s*&&\s*\([\s\S]*?aria-label="Load more reports"[\s\S]*?\}\s*\}/);
    });

    it('controlled filterType — chips call onFilterTypeChange (parent state)', () => {
      // The chip onClick must invoke the parent-supplied setter, not a
      // local one (which would silently filter locally).
      expect(panelSource).toMatch(/onClick=\{\(\)\s*=>\s*onFilterTypeChange\?\.\(null\)\}/);
      expect(panelSource).toMatch(/onClick=\{\(\)\s*=>\s*onFilterTypeChange\?\.\(filterType\s*===\s*t\s*\?\s*null\s*:\s*t\)\}/);
    });

    it('local setFilterType is gone — ReportSection does not own filter state', () => {
      // The previous code had `const [filterType, setFilterType] = useState(null);`
      // inside ReportSection. We lifted that to the parent; the local
      // useState must no longer be present.
      expect(panelSource).not.toMatch(/function ReportSection\([\s\S]*?\{[\s\S]{0,200}const\s+\[filterType,\s*setFilterType\]\s*=\s*useState/);
    });
  });
});
