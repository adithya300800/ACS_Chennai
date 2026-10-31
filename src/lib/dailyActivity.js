function recordActivity(records, kind, today) {
  const listPath = kind === 'DPR' ? '/portal/dpr/my' : '/portal/inspection/my';
  const submitPath = kind === 'DPR'
    ? '/portal/dpr/submit'
    : `/portal/inspection/submit?date=${encodeURIComponent(today)}`;
  if (!Array.isArray(records)) return { kind, state: "Couldn't load", action: 'Retry', failed: true };
  const rows = records;
  const filed = rows.find((row) => row.status !== 'DRAFT');
  const draft = rows.find((row) => row.status === 'DRAFT');

  if (filed && draft) {
    const route = kind === 'DPR' ? '/portal/dpr/submit' : '/portal/inspection/submit';
    return {
      kind,
      state: 'Filed today · draft saved',
      action: 'Continue draft',
      to: `${route}?draftId=${encodeURIComponent(draft.id)}`,
    };
  }
  if (filed) return { kind, state: 'Filed today', action: 'View records', to: listPath };
  if (draft) {
    const route = kind === 'DPR' ? '/portal/dpr/submit' : '/portal/inspection/submit';
    return { kind, state: 'Draft saved', action: 'Continue draft', to: `${route}?draftId=${encodeURIComponent(draft.id)}` };
  }
  return { kind, state: 'No record yet', action: `Create ${kind}`, to: submitPath };
}

// These are activity shortcuts, not required tasks: whether a report is
// expected depends on the employee's role and the work scheduled today.
export function deriveDailyActivity(dprs, inspections, today) {
  return [
    recordActivity(dprs, 'DPR', today),
    recordActivity(inspections, 'Inspection', today),
  ];
}