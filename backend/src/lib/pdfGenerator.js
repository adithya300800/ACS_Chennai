/**
 * PDF Generator for DPR module
 * Requires: puppeteer, handlebars
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const TEMPLATE_PATH = path.join(__dirname, '../../templates/dpr-pdf.hbs');

let templateCache = null;

async function getTemplate() {
  if (!templateCache) {
    const templateContent = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    templateCache = Handlebars.compile(templateContent);
  }
  return templateCache;
}

/**
 * Generate PDF buffer for a DPR
 * @param {object} dpr - DPR record with photos, submittedBy, etc.
 * @param {object} options
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateDPRPdf(dpr, options = {}) {
  const template = await getTemplate();

  const html = template({
    dpr,
    generatedAt: new Date().toISOString(),
    ...options,
  });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const buffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });

    return Buffer.from(buffer);
  } finally {
    await browser.close();
  }
}

/**
 * Register additional Handlebars helpers
 */
Handlebars.registerHelper('formatDate', function (date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
});

Handlebars.registerHelper('formatDateTime', function (date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
});

Handlebars.registerHelper('statusLabel', function (status) {
  const labels = {
    DRAFT: 'Draft',
    SUBMITTED: 'Submitted',
    UNDER_REVIEW: 'Under Review',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
  };
  return labels[status] || status;
});

Handlebars.registerHelper('statusColor', function (status) {
  const colors = {
    DRAFT: '#6b7280',
    SUBMITTED: '#2563eb',
    UNDER_REVIEW: '#d97706',
    APPROVED: '#16a34a',
    REJECTED: '#dc2626',
  };
  return colors[status] || '#6b7280';
});

module.exports = { generateDPRPdf };
