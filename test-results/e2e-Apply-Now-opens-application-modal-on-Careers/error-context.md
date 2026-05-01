# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e.test.js >> Apply Now opens application modal on Careers
- Location: e2e.test.js:45:5

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('button').filter({ hasText: 'Apply Now' }).first()

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - text: The server is configured with a public base URL of /ACS_Chennai/ - did you mean to visit
  - link "/ACS_Chennai/careers" [ref=e2] [cursor=pointer]:
    - /url: /ACS_Chennai/careers
  - text: instead?
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | const BASE = 'http://localhost:5173';
  4  | 
  5  | test('Homepage loads', async ({ page }) => {
  6  |   await page.goto(BASE);
  7  |   await expect(page).toHaveTitle(/ACS Chennai/);
  8  | });
  9  | 
  10 | test('Nav active state visible on /blog', async ({ page }) => {
  11 |   await page.goto(`${BASE}/blog`);
  12 |   await page.waitForTimeout(500);
  13 |   const blogLink = page.locator('nav a').filter({ hasText: 'Blog' });
  14 |   await expect(blogLink).toHaveClass(/active/);
  15 | });
  16 | 
  17 | test('Careers page loads at /careers route', async ({ page }) => {
  18 |   await page.goto(`${BASE}/careers`);
  19 |   await page.waitForTimeout(500);
  20 |   await expect(page.locator('h2', { hasText: 'Join the ACS Chennai Team' })).toBeVisible();
  21 | });
  22 | 
  23 | test('Blog article loads at /blog/:slug', async ({ page }) => {
  24 |   await page.goto(`${BASE}/blog/construction-schedule-failing`);
  25 |   await page.waitForTimeout(500);
  26 |   await expect(page.locator('h1', { hasText: /Construction Schedule/ })).toBeVisible();
  27 | });
  28 | 
  29 | test('Read Article links navigate to article', async ({ page }) => {
  30 |   await page.goto(`${BASE}/blog`);
  31 |   await page.waitForTimeout(500);
  32 |   await page.locator('.blog-card .read-more').first().click();
  33 |   await page.waitForTimeout(500);
  34 |   await expect(page).toHaveURL(/\/blog\/.+/);
  35 | });
  36 | 
  37 | test('Contact page has inquiry form', async ({ page }) => {
  38 |   await page.goto(`${BASE}/contact`);
  39 |   await page.waitForTimeout(500);
  40 |   await expect(page.locator('form')).toBeVisible();
  41 |   await expect(page.locator('input[name="name"]')).toBeVisible();
  42 |   await expect(page.locator('textarea[name="message"]')).toBeVisible();
  43 | });
  44 | 
  45 | test('Apply Now opens application modal on Careers', async ({ page }) => {
  46 |   await page.goto(`${BASE}/careers`);
  47 |   await page.waitForTimeout(500);
> 48 |   await page.locator('button', { hasText: 'Apply Now' }).first().click();
     |                                                                  ^ Error: locator.click: Test timeout of 30000ms exceeded.
  49 |   await expect(page.locator('input[name="name"]')).toBeVisible();
  50 | });
  51 | 
  52 | test('Phone numbers are no longer placeholder values', async ({ page }) => {
  53 |   await page.goto(`${BASE}/contact`);
  54 |   await page.waitForTimeout(500);
  55 |   const phoneValue = await page.locator('.contact-card-value').first().innerText();
  56 |   expect(phoneValue).not.toContain('0000 0000');
  57 | });
  58 | 
```