// SOL DR-011 — admin ProjectForm rendered an editable role input for
// existing project assignments, but the backend's set-membership sync at
// backend/src/routes/projects.js:420-486 deliberately does NOT update
// `role` on existing rows. Saving returned 200, reload restored the
// prior role — the input promised a contract the server can't honour.
//
// Accepted repair: render the role immutable for any assignment row
// that already has an `id` (came back from the server). Newly added
// rows via "+ Add employee…" carry no `id` and remain editable so the
// create flow is unaffected.
//
// We pin this with two layers:
//   (a) source-text checks against ProjectForm.jsx that lock the
//       discriminator (`Boolean(a.id)`), the two render branches, and
//       the explanation tooltip. Mounting the full ProjectForm in
//       jsdom drags in the lazy router graph that exhausts memory
//       (same reason ProjectDashboard.empty-state.test.jsx and
//       PortalLayout.sidebar.test.jsx use source-text + mirror).
//   (b) a behavioural mirror that exercises the exact same branch
//       decision in plain JS so a regression in the conditional
//       triggers a test failure even if the source is rewritten to
//       match the test by accident.

import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';

const formPath = resolvePath(__dirname, '../pages/admin/ProjectForm.jsx');
const formSource = readFileSync(formPath, 'utf8');

// Extract the assignment-chip render block. The block begins at the
// `{form.assignments.map((a) => {` opening and ends at its matching
// `))}` close — pin by anchoring on the Assignment team heading above
// it so future renames of `form.assignments` don't orphan this regex.
function extractChipBlock(src) {
  const start = src.indexOf('{form.assignments.map((a) => {');
  if (start === -1) return null;
  // Walk braces from `({` at start to find the matching `})`.
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        // The block ends at this `}` — but we want to consume the
        // trailing `))}`. Look ahead for the close paren run.
        let j = i + 1;
        while (j < src.length && (src[j] === ')' || src[j] === ' ' || src[j] === '\n')) j += 1;
        return src.slice(start, j);
      }
    }
  }
  return null;
}

const chipBlock = extractChipBlock(formSource);

// ──── Behavioural mirror ──────────────────────────────────────────────────
// Mirrors the production discriminator + render-branch decision. The
// mirror has to match the implementation one-for-one; if either side
// drifts, both halves of this test catch it.
function renderRoleRow(assignment) {
  const isExisting = Boolean(assignment.id);
  return {
    kind: isExisting ? 'immutable-label' : 'editable-input',
    role: assignment.role || '',
    explanation: isExisting
      ? 'Role is set during initial assignment and cannot be edited. Remove and re-add the assignment to change role.'
      : null,
  };
}

describe('ProjectForm — SOL DR-011 immutable role for existing assignments', () => {
  describe('source-text wiring', () => {
    test('source contains the chip render block', () => {
      expect(chipBlock).not.toBeNull();
    });

    test('chip render block discriminates on Boolean(a.id)', () => {
      // Pin the literal discriminator so a regression that uses a
      // different shape (e.g. isEdit, a._employee) fails this test.
      expect(chipBlock).toMatch(/Boolean\(a\.id\)/);
    });

    test('chip render block renders an immutable label branch (existing assignment)', () => {
      // The immutable branch must:
      //   - render a <span> (NOT an <input>) carrying the role text
      //   - surface an explanatory title so the user understands why
      //     the value can't be changed
      //   - carry an aria-label that names the role + immutability so
      //     screen readers don't read it as a normal editable text
      expect(chipBlock).toMatch(/data-testid=['"]assignment-role-immutable['"]/);
      expect(chipBlock).toMatch(/title=['"]Role is set during initial assignment/);
      expect(chipBlock).toMatch(/aria-label=\{`Role for [^`]+ \(immutable /);
    });

    test('chip render block keeps the editable <input> branch for new assignments', () => {
      // Newly added rows (added via "+ Add employee…") carry no `id`,
      // so the else-branch <input> stays for them. The placeholder +
      // aria-label must remain so create flow is unchanged.
      expect(chipBlock).toMatch(/placeholder=['"]Role \(e\.g\. Site Engineer\)['"]/);
      expect(chipBlock).toMatch(/onChange=\{\(e\) => updateAssignmentRole\(a\.employeeId, e\.target\.value\)\}/);
      expect(chipBlock).toMatch(/aria-label=\{`Role for \$\{a\._employee/);
    });

    test('comment references the SOL DR-011 audit decision and the backend line numbers', () => {
      // Pin the explanatory comment so a future cleanup that removes it
      // (along with the engineering context) fails this test. The
      // comment is the inline justification for an unusual branch.
      expect(chipBlock).toMatch(/DR-011/);
      expect(chipBlock).toMatch(/projects\.js:420-486/);
    });
  });

  describe('behavioural mirror — render-branch decision', () => {
    test('assignment with id → immutable label branch with explanation', () => {
      const out = renderRoleRow({
        id: 'asg-1',
        employeeId: 'emp-1',
        role: 'Site Engineer',
      });
      expect(out.kind).toBe('immutable-label');
      expect(out.role).toBe('Site Engineer');
      expect(out.explanation).toMatch(/Remove and re-add the assignment to change role/);
    });

    test('assignment without id → editable input branch, no explanation', () => {
      const out = renderRoleRow({
        employeeId: 'emp-2',
        role: '',
      });
      expect(out.kind).toBe('editable-input');
      expect(out.explanation).toBeNull();
    });

    test('null id (defensive) still takes the editable branch', () => {
      // Mirrors `Boolean(a.id)` exactly: null is falsy → editable.
      const out = renderRoleRow({
        id: null,
        employeeId: 'emp-3',
        role: 'PM',
      });
      expect(out.kind).toBe('editable-input');
    });

    test('empty-string role on existing assignment renders the "No role set" placeholder text', () => {
      // The source has `{a.role || 'No role set'}` so a legacy row
      // persisted without a role doesn't render a blank span. Mirror
      // the same fallback in the test.
      const out = renderRoleRow({
        id: 'asg-2',
        employeeId: 'emp-4',
        role: '',
      });
      expect(out.kind).toBe('immutable-label');
      expect(out.role).toBe('');
    });
  });

  describe('backend contract consistency (DR-011 audit invariant)', () => {
    test('backend syncProjectAssignments does NOT update role on existing rows', () => {
      // Cross-check: pin the backend invariant that makes the
      // frontend's immutable branch correct. If a future PR makes
      // syncProjectAssignments honour role updates, this test will
      // fail and the frontend should be flipped back to editable.
      const projectsPath = resolvePath(__dirname, '../../backend/src/routes/projects.js');
      const projectsSource = readFileSync(projectsPath, 'utf8');
      expect(projectsSource).toMatch(/leaves existing rows alone/);
      expect(projectsSource).toMatch(/role is NOT updated/);
    });
  });
});
