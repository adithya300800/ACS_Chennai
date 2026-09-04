// Round-26: Admin-targeted recipient lookup.
//
// The employee notification path uses `notification.employeeId` as the
// recipient and looks up that one employee's preferences + email address.
// Admin fan-out instead iterates every active admin user (currently just
// `isAdmin: true` — the Employee model has no isActive column) and sends
// one email per admin with each admin's individual preferences honoured.
//
// This helper is intentionally tiny — just a Prisma query. The fan-out
// orchestration (per-admin preference lookup, send, audit log) lives in
// `lib/notify.js#fanOutToAdmins` so the recipient discovery is reusable
// from the training-overdue sweep, the admin attendance digest, and any
// future admin-targeted notification type.

'use strict';

/**
 * Return the set of admin users that should receive admin-targeted email
 * notifications. Today this is every Employee with isAdmin=true; if a
 * soft-delete / inactive flag is added later, filter on it here so call
 * sites don't need to know.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<Array<{ id: string, email: string, name: string }>>}
 */
async function findActiveAdmins(prisma) {
  if (!prisma || typeof prisma.employee?.findMany !== 'function') {
    return [];
  }
  return prisma.employee.findMany({
    where: { isAdmin: true },
    select: { id: true, email: true, name: true },
  });
}

module.exports = { findActiveAdmins };
