/**
 * PDF Generator for DPR module.
 *
 * NOTE: Puppeteer is NOT used in production because Azure App Service Linux does
 * not ship the system libraries Puppeteer's bundled Chromium requires. PDF
 * generation is currently a placeholder; the DPR `/pdf` route returns a
 * `pdfUrl` pointing to a placeholder endpoint.
 *
 * To enable real PDF generation, choose ONE of:
 *  1. Migrate to `pdfkit` or `@react-pdf/renderer` (pure-JS, no Chromium)
 *  2. Run PDF generation in a separate Azure Function / Container App with a
 *     Puppeteer-compatible base image
 *  3. Use Azure's "Convert HTML to PDF" service
 */

const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const TEMPLATE_PATH = path.join(__dirname, '../../templates/dpr-pdf.hbs');

let templateCache = null;

async function getTemplate() {
  if (!templateCache) {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`DPR PDF template not found at ${TEMPLATE_PATH}`);
    }
    const templateContent = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
    templateCache = Handlebars.compile(templateContent);
  }
  return templateCache;
}

/**
 * Render a DPR to its HTML representation using the Handlebars template.
 * Returns a Buffer of HTML bytes — not a PDF — until a PDF backend is wired up.
 *
 * @param {object} dpr - DPR record with photos, submittedBy, etc.
 * @param {object} options
 * @returns {Promise<{ html: Buffer, format: 'html' }>}
 */
async function generateDPRHtml(dpr, options = {}) {
  const template = await getTemplate();
  const html = template({
    dpr,
    generatedAt: new Date().toISOString(),
    ...options,
  });
  return { html: Buffer.from(html, 'utf-8'), format: 'html' };
}

/**
 * Generate PDF buffer for a DPR. Currently throws — wire up a backend (see file
 * header) before calling.
 */
async function generateDPRPdf(_dpr, _options = {}) {
  throw new Error(
    'PDF generation is disabled. Wire up pdfkit / @react-pdf/renderer or an external ' +
    'service before calling generateDPRPdf.'
  );
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

module.exports = { generateDPRPdf, generateDPRHtml };
