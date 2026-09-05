// [N3] Phase E: shared drawing-link resolution for DPR + Inspection.
//
// Both routes accept the same drawingId + drawingRev payload and apply the
// same guards:
//   - drawingId absent              → no change (create default: null)
//   - drawingId = null              → clears the link; drawingRev also null
//   - drawingId = "<uuid>"          → lookup; 400 if not found or belongs
//                                     to a different project than the
//                                     report's resolved project
//                                     (resolvedProjectId); drawingRev
//                                     defaults to drawing.revision when
//                                     not supplied
//   - drawingRev = "<string>"       → stored verbatim up to 20 chars
//
// Returns:
//   { drawingId, drawingRev }      → ready for the Prisma create/update
//                                     payload (both nullable)
//   { error }                       → on validation failure. The caller
//                                     inspects the shape:
//                                     - error is a string → flat 400 VALIDATION_ERROR
//                                     - error is an object → use status + body verbatim
//
// Routes consume the helper as:
//   const r = await resolveDrawingForReport({ prisma, drawingId, drawingRev, resolvedProjectId });
//   if (r.error) {
//     if (typeof r.error === 'string') {
//       return res.status(400).json({ error: 'VALIDATION_ERROR', code: 'VALIDATION_ERROR', message: r.error });
//     }
//     return res.status(r.error.status).json(r.error.body);
//   }
//   fields.drawingId = r.drawingId ?? null;
//   fields.drawingRev = r.drawingRev ?? null;
async function resolveDrawingForReport({ prisma, drawingId, drawingRev, resolvedProjectId }) {
  if (drawingId === null) {
    return { drawingId: null, drawingRev: null };
  }
  if (drawingId === undefined) {
    return { drawingId: undefined, drawingRev: undefined };
  }
  if (typeof drawingId !== 'string' || !drawingId) {
    return { error: 'drawingId must be a string or null' };
  }
  const drawing = await prisma.drawing.findUnique({
    where: { id: drawingId },
    select: { id: true, projectId: true, revision: true, status: true },
  });
  if (!drawing) {
    return { error: { status: 400, body: { error: 'DRAWING_NOT_FOUND', code: 'DRAWING_NOT_FOUND', message: 'Linked drawing does not exist' } } };
  }
  // Cross-project guard: a report for Project A cannot link to a
  // drawing registered under Project B.
  if (resolvedProjectId && drawing.projectId !== resolvedProjectId) {
    return { error: { status: 400, body: { error: 'DRAWING_PROJECT_MISMATCH', code: 'DRAWING_PROJECT_MISMATCH', message: 'Linked drawing belongs to a different project' } } };
  }
  let resolvedRev = drawing.revision;
  if (drawingRev !== undefined && drawingRev !== null) {
    if (typeof drawingRev !== 'string') {
      return { error: 'drawingRev must be a string' };
    }
    if (drawingRev.length > 20) {
      return { error: 'drawingRev exceeds 20 chars' };
    }
    resolvedRev = drawingRev;
  }
  return { drawingId: drawing.id, drawingRev: resolvedRev };
}

module.exports = { resolveDrawingForReport };
