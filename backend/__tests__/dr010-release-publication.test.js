// SOL DR-010 — release publication guarantees regression coverage.
//
// Three contracts pinned here:
//
//   A. The Render deploy trigger pins the deploy to the EXACT github SHA,
//      not a branch ref. Pre-fix the body was `{"branch":"add-react-website"}`,
//      which made Render resolve the branch head at trigger time — so the
//      deployed code could be a newer commit than the one the CI tested.
//
//   B. Backend deploys are SERIALIZED via a workflow-level concurrency
//      group. Pre-fix, two concurrent pushes could race and the SHA gate
//      would see the second commit's SHA before the first deploy had
//      finished binding env vars.
//
//   C. Frontend test + build gate is INDEPENDENT of any publisher
//      (frontend-ci.yml). Pre-fix the gate lived inside deploy.yml
//      (the Pages publisher) so when acschennai.com cuts over to
//      Render static site and deploy.yml is retired, the gate would
//      die with it.
//
//   D. deploy.yml now waits on frontend-ci's success via workflow_run
//      (with a manual bypass for workflow_dispatch). Without this
//      linkage, a failed gate silently publishes anyway.

const fs = require('fs');
const path = require('path');

const BACKEND_DEPLOY = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'backend-deploy.yml'),
  'utf8',
);

const FRONTEND_CI = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'frontend-ci.yml'),
  'utf8',
);

const DEPLOY = fs.readFileSync(
  path.join(__dirname, '..', '..', '.github', 'workflows', 'deploy.yml'),
  'utf8',
);

describe('SOL DR-010 — release publication guarantees', () => {
  test('A1. backend-deploy pins the deploy trigger to the exact github SHA', () => {
    // The pre-fix trigger body was `{"branch":"add-react-website"}`. The
    // DR-010 fix sends `{"commit":"<github.sha>"}` so Render deploys
    // exactly the tested commit regardless of subsequent branch updates.
    expect(BACKEND_DEPLOY).toMatch(/"commit"/);
    expect(BACKEND_DEPLOY).toMatch(/github\.sha/);
    expect(BACKEND_DEPLOY).toMatch(/PINNED_SHA/);
    // Negative: no bare-branch body. Strip comments so the regression
    // test doesn't false-positive on the prose in the DR-010 comment
    // header that describes the old pattern.
    const code = BACKEND_DEPLOY
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/\{"branch"\s*:\s*"add-react-website"\}/);
  });

  test('A2. backend-deploy logs the pinned SHA in its echo for forensics', () => {
    // Operator-visible evidence: the SHA we pinned must be the same one
    // we echo. If the printf template gets edited to drop github.sha
    // later, this catches the regression.
    expect(BACKEND_DEPLOY).toMatch(/commit=\$PINNED_SHA/);
  });

  test('B1. backend-deploy has a workflow-level concurrency group', () => {
    expect(BACKEND_DEPLOY).toMatch(/^concurrency:/m);
    expect(BACKEND_DEPLOY).toMatch(/group:\s*['"]?render-backend-deploy['"]?/);
    expect(BACKEND_DEPLOY).toMatch(/cancel-in-progress:\s*true/);
  });

  test('B2. backend-deploy concurrency group is distinct from the Pages publisher group', () => {
    // If both workflows used the same concurrency group, a slow Pages
    // build could block a backend deploy or vice versa. Distinct groups
    // serialize within each publisher without coupling across them.
    const backendMatch = BACKEND_DEPLOY.match(/group:\s*['"]?(render-backend-deploy|pages)['"]?/);
    expect(backendMatch).not.toBeNull();
    expect(backendMatch[1]).toBe('render-backend-deploy');
  });

  test('C1. frontend-ci.yml exists as a publisher-independent gate', () => {
    // The test + build gate must live in its own workflow file. Pre-fix
    // it was inline in deploy.yml and would die when that file is
    // retired at the Pages→Render cutover (docs/HOSTING_CUTOVER.md).
    expect(FRONTEND_CI).toMatch(/name:\s*Frontend CI/);
    expect(FRONTEND_CI).toMatch(/on:\s*\n[\s\S]*?push:\s*\n[\s\S]*?branches:\s*\[\s*add-react-website\s*\]/);
    // The gate must run frontend tests + build (the same two steps
    // deploy.yml used to inline).
    expect(FRONTEND_CI).toMatch(/npx jest --testPathPattern/);
    expect(FRONTEND_CI).toMatch(/npm run build/);
  });

  test('C2. frontend-ci.yml does not deploy anything itself', () => {
    // The whole point of decoupling the gate is that the gate is NOT
    // a publisher. If a future engineer adds a deploy job here, this
    // catches it so they can decide deliberately.
    expect(FRONTEND_CI).not.toMatch(/uses:\s*actions\/deploy-pages/);
    expect(FRONTEND_CI).not.toMatch(/uses:\s*actions\/upload-pages-artifact/);
  });

  test('D1. deploy.yml now waits on frontend-ci via workflow_run', () => {
    expect(DEPLOY).toMatch(/workflow_run:/);
    expect(DEPLOY).toMatch(/workflows:\s*\[\s*['"]Frontend CI \(test \+ build gate\)['"]\s*\]/);
    expect(DEPLOY).toMatch(/branches:\s*\[\s*add-react-website\s*\]/);
  });

  test('D2. deploy.yml build job skips on frontend-ci failure (or runs on push/dispatch)', () => {
    // The job-level `if:` must (a) allow direct push / manual dispatch
    // through without the gate check, AND (b) skip when frontend-ci
    // ran and concluded non-success.
    const buildJob = DEPLOY.match(/jobs:\s*\n\s*build:\s*\n[\s\S]*?runs-on:/);
    expect(buildJob).not.toBeNull();
    expect(buildJob[0]).toMatch(/github\.event_name\s*==\s*['"]push['"]/);
    expect(buildJob[0]).toMatch(/github\.event_name\s*==\s*['"]workflow_dispatch['"]/);
    expect(buildJob[0]).toMatch(/github\.event\.workflow_run\.conclusion\s*==\s*['"]success['"]/);
  });

  test('D3. deploy.yml no longer inlines the test step', () => {
    // The whole reason for moving the test out is so that publisher-
    // retirement doesn't kill the gate. If a future engineer re-adds
    // `npx jest` here thinking it's belt-and-suspenders, this catches
    // it.
    expect(DEPLOY).not.toMatch(/npx jest/);
  });
});
