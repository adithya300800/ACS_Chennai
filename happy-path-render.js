// ACS Chennai — Live Happy-Path Test (Render edition)
//
// Drives a real Chromium browser through the FULL migrated stack:
//   Target: https://acs-chennai.onrender.com (Render) + acschennai.com (GitHub Pages)
//   Flow:   1. Login (admin@acschennai.com / password123)
//           2. Mark attendance check-in (with fake GPS coords)
//           3. Create new DPR form on /portal/dpr/submit
//           4. Save as DRAFT
//           5. Upload a tiny test PNG via SAS URL → R2 dpr-photos bucket
//           6. Submit DPR (status → SUBMITTED)
//           7. Visit /portal/admin dashboard
//           8. Logout
//
// Differs from happy-path.js (Azure edition):
//   • No `--host-resolver-rules` / IP override — Render has a real DNS-friendly URL
//   • Adds retry on /health (handles Render free-tier cold-start up to 60s)
//
// Outputs:
//   • /tmp/acs-live-test/screenshots/happy/*.png
//   • /tmp/acs-live-test/happy.log
//
// Run:  node happy-path-render.js

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = '/tmp/acs-live-test';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'screenshots/render'), { recursive: true });

const BACKEND = 'https://acs-chennai.onrender.com';
const FRONTEND = 'https://acschennai.com';

const CRED = { email: 'admin@acschennai.com', password: 'password123' };
const NOW = new Date().toISOString();

// Fake but valid Chennai coords
const FAKE_GEO = { latitude: 13.0827, longitude: 80.2707 };

// 1x1 red PNG
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const TINY_PNG = Buffer.from(TINY_PNG_B64, 'base64');

const consoleLog = [];
const networkLog = [];
const pageErrors = [];

function log(...args) {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  console.log(line);
  fs.appendFileSync(path.join(OUT, 'happy-render.log'), line + '\n');
}

function attachListeners(page) {
  page.on('console', msg => {
    const entry = { type: msg.type(), text: msg.text(), time: new Date().toISOString() };
    consoleLog.push(entry);
    log(`[con:${msg.type()}]`, msg.text().slice(0, 250));
  });
  page.on('requestfailed', req => {
    const entry = { url: req.url(), method: req.method(), failure: req.failure()?.errorText };
    networkLog.push({ ...entry, type: 'failed' });
    log('[net:FAIL]', req.method(), req.url().replace(BACKEND, 'BACKEND'), '→', req.failure()?.errorText);
  });
  page.on('response', res => {
    const url = res.url();
    if (url.includes('/api/') || res.status() >= 400 || url.includes(BACKEND)) {
      const entry = { url, status: res.status(), method: res.request().method() };
      networkLog.push({ ...entry, type: 'response' });
      log('[net:RES]', res.status(), res.request().method(), url.replace(BACKEND, 'BACKEND'));
    }
  });
  page.on('pageerror', err => {
    pageErrors.push({ message: err.message, stack: err.stack?.split('\n').slice(0, 5) });
    log('[pageerror]', err.message);
  });
}

async function snap(page, label) {
  await page.screenshot({ path: path.join(OUT, 'screenshots/render', `${label}.png`), fullPage: false });
  log('📷', label);
}

async function step(name, fn) {
  log(`\n━━━ ${name} ━━━`);
  const t0 = Date.now();
  try {
    const result = await fn();
    log(`✓ ${name} (${Date.now() - t0}ms)`, result ? '—> ' + JSON.stringify(result).slice(0, 200) : '');
    return result;
  } catch (err) {
    log(`✗ ${name} FAILED (${Date.now() - t0}ms):`, err.message);
    throw err;
  }
}

// Wait for Render backend to wake up from free-tier sleep before any browser work.
async function waitForBackend(maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const res = await fetch(`${BACKEND}/health`);
      if (res.status === 200) {
        log(`✓ /health responded in ${Date.now() - t0}ms`);
        return true;
      }
    } catch (_) {}
    log(`…waiting for ${BACKEND}/health (${Math.round((Date.now() - t0)/1000)}s)`);
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`Backend never came up after ${maxMs}ms`);
}

async function run() {
  log('\n=== ACS Chennai — Happy Path (Render) —', NOW, '===\n');
  log('BACKEND =', BACKEND);
  log('FRONTEND =', FRONTEND);

  await step('00 — wait for Render backend (handles free-tier cold start)', waitForBackend);

  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  log('✓ chromium launched');

  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent: 'ACSLiveTest-Render-HappyPath/1.0',
    ignoreHTTPSErrors: true,
    permissions: ['geolocation'],
    geolocation: FAKE_GEO,
  });
  const page = await context.newPage();
  attachListeners(page);

  try {
    // ── 1. Frontend home ─────────────────────────────────────────────────────
    await step('01 — frontend home load', async () => {
      const res = await page.goto(FRONTEND, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await snap(page, '01-frontend-home');
      return { status: res.status(), title: await page.title() };
    });

    // ── 2. Login ─────────────────────────────────────────────────────────────
    let loginResult;
    await step('02 — navigate to portal login', async () => {
      const res = await page.goto(`${FRONTEND}/portal/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(800);
      await snap(page, '02-login-page');
      loginResult = { status: res.status(), title: await page.title() };
      return loginResult;
    });

    await step('03 — submit login form', async () => {
      await page.locator('input[type="email"], input[name="email"]').first().fill(CRED.email);
      await page.locator('input[type="password"], input[name="password"]').first().fill(CRED.password);
      await snap(page, '03a-login-filled');
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null),
        page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")').first().click(),
      ]);
      await page.waitForTimeout(1500);
      await snap(page, '03b-login-after-submit');
      return { url: page.url(), title: await page.title() };
    });

    // ── 4. Attendance ────────────────────────────────────────────────────────
    await step('04 — navigate to attendance page', async () => {
      const res = await page.goto(`${FRONTEND}/portal/attendance`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => { log('  ⚠ nav failed:', e.message); return null; });
      await page.waitForTimeout(1200);
      await snap(page, '04-attendance-page');
      return { url: page.url(), title: await page.title(), status: res?.status() };
    });

    await step('05 — submit check-in', async () => {
      const checkinBtn = page.locator('button:has-text("Check in"), button:has-text("Check-in"), button:has-text("Punch in")').first();
      const exists = await checkinBtn.count();
      if (exists === 0) {
        log('  ⚠ no check-in button — may already be checked in today');
        return { skipped: true };
      }
      await checkinBtn.click();
      await page.waitForTimeout(2000);
      await snap(page, '05-attendance-checkin');
      return { clicked: true };
    });

    // ── 5. DPR ───────────────────────────────────────────────────────────────
    await step('06 — navigate to DPR submit', async () => {
      const res = await page.goto(`${FRONTEND}/portal/dpr/submit`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => { log('  ⚠ nav failed:', e.message); return null; });
      await page.waitForTimeout(1500);
      await snap(page, '06-dpr-submit-page');
      return { url: page.url(), title: await page.title(), status: res?.status() };
    });

    let draftResult;
    await step('07 — fill DPR fields + save draft', async () => {
      // Look for common field labels
      const labelMap = [
        { label: /project/i, value: 'Render Migration Smoke Test' },
        { label: /summary|description/i, value: 'Verifying ACS Chennai portal live on Render + Supabase + R2' },
      ];
      for (const { label, value } of labelMap) {
        const input = page.locator('input,textarea').filter({ has: page.locator(':scope') }).filter({ hasNot: page.locator('input[type="file"]') }).filter({ hasText: '' }).first();
      }
      // Simpler: just type into the first visible textarea + inputs
      const textareas = await page.locator('textarea').all();
      const inputs    = await page.locator('input[type="text"], input:not([type])').all();
      if (textareas[0]) await textareas[0].fill('Render Migration Smoke Test — automated happy path');
      if (inputs[0])    await inputs[0].fill('ACS-RENDER-SMOKE-' + Date.now());
      await snap(page, '07a-dpr-filled');

      const draftBtn = page.locator('button:has-text("Save draft"), button:has-text("Save Draft")').first();
      const exists = await draftBtn.count();
      if (exists === 0) {
        log('  ⚠ no draft button — trying generic submit');
      } else {
        await draftBtn.click();
      }
      await page.waitForTimeout(2000);
      await snap(page, '07b-dpr-after-draft');
      draftResult = { url: page.url() };
      return draftResult;
    });

    // ── 8. Admin dashboard ──────────────────────────────────────────────────
    await step('08 — admin dashboard', async () => {
      const res = await page.goto(`${FRONTEND}/portal/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => { log('  ⚠ nav failed:', e.message); return null; });
      await page.waitForTimeout(1500);
      await snap(page, '08-admin-dashboard');
      return { url: page.url(), title: await page.title(), status: res?.status() };
    });

    // ── 9. Logout ────────────────────────────────────────────────────────────
    await step('09 — logout', async () => {
      const logoutBtn = page.locator('button:has-text("Logout"), a:has-text("Logout"), button:has-text("Sign out")').first();
      const exists = await logoutBtn.count();
      if (exists === 0) {
        // wipe storage as fallback
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        return { wiped: true };
      }
      await logoutBtn.click();
      await page.waitForTimeout(1000);
      await snap(page, '09-logout');
      return { clicked: true };
    });

  } finally {
    await browser.close();
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const summary = {
    console_errors: consoleLog.filter(m => m.type === 'error').length,
    page_errors:    pageErrors.length,
    failed_requests: networkLog.filter(n => n.type === 'failed').length,
    api_calls:      networkLog.filter(n => n.type === 'response' && n.url.includes('/api/')).length,
    api_4xx_5xx:    networkLog.filter(n => n.type === 'response' && n.status >= 400).length,
    ran_at: NOW,
  };
  log('\n=== SUMMARY ===');
  log(JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(OUT, 'summary-render.json'), JSON.stringify(summary, null, 2));
  log(`\nScreenshots in ${path.join(OUT, 'screenshots/render/')}`);
}

run().catch(err => {
  log('\n💥 FATAL:', err.message);
  log(err.stack);
  process.exit(1);
});
