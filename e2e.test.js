import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5173';

test('Homepage loads', async ({ page }) => {
  await page.goto(BASE);
  await expect(page).toHaveTitle(/ACS Chennai/);
});

test('Nav active state visible on /blog', async ({ page }) => {
  await page.goto(`${BASE}/blog`);
  await page.waitForTimeout(500);
  const blogLink = page.locator('nav a').filter({ hasText: 'Blog' });
  await expect(blogLink).toHaveClass(/active/);
});

test('Careers page loads at /careers route', async ({ page }) => {
  await page.goto(`${BASE}/careers`);
  await page.waitForTimeout(500);
  await expect(page.locator('h2', { hasText: 'Join the ACS Chennai Team' })).toBeVisible();
});

test('Blog article loads at /blog/:slug', async ({ page }) => {
  await page.goto(`${BASE}/blog/construction-schedule-failing`);
  await page.waitForTimeout(500);
  await expect(page.locator('h1', { hasText: /Construction Schedule/ })).toBeVisible();
});

test('Read Article links navigate to article', async ({ page }) => {
  await page.goto(`${BASE}/blog`);
  await page.waitForTimeout(500);
  await page.locator('.blog-card .read-more').first().click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/blog\/.+/);
});

test('Contact page has inquiry form', async ({ page }) => {
  await page.goto(`${BASE}/contact`);
  await page.waitForTimeout(500);
  await expect(page.locator('form')).toBeVisible();
  await expect(page.locator('input[name="name"]')).toBeVisible();
  await expect(page.locator('textarea[name="message"]')).toBeVisible();
});

test('Apply Now opens application modal on Careers', async ({ page }) => {
  await page.goto(`${BASE}/careers`);
  await page.waitForTimeout(500);
  await page.locator('button', { hasText: 'Apply Now' }).first().click();
  await expect(page.locator('input[name="name"]')).toBeVisible();
});

test('Phone numbers are no longer placeholder values', async ({ page }) => {
  await page.goto(`${BASE}/contact`);
  await page.waitForTimeout(500);
  const phoneValue = await page.locator('.contact-card-value').first().innerText();
  expect(phoneValue).not.toContain('0000 0000');
});
