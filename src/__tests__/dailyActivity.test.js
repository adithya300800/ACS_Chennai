import { deriveDailyActivity } from '../lib/dailyActivity.js';

const TODAY = '2026-10-31';

describe('deriveDailyActivity', () => {
  test('offers creation shortcuts when there are no records today', () => {
    expect(deriveDailyActivity([], [], TODAY)).toEqual([
      { kind: 'DPR', state: 'No record yet', action: 'Create DPR', to: '/portal/dpr/submit?date=2026-10-31' },
      { kind: 'Inspection', state: 'No record yet', action: 'Create Inspection', to: '/portal/inspection/submit?date=2026-10-31' },
    ]);
  });

  test('continues a saved draft and links to its owner-scoped editor', () => {
    const [dpr, inspection] = deriveDailyActivity(
      [{ id: 'dpr-1', status: 'DRAFT' }],
      [{ id: 'inspection-1', status: 'DRAFT' }],
      TODAY,
    );
    expect(dpr).toMatchObject({ state: 'Draft saved', action: 'Continue draft', to: '/portal/dpr/submit?draftId=dpr-1' });
    expect(inspection).toMatchObject({ state: 'Draft saved', action: 'Continue draft', to: '/portal/inspection/submit?draftId=inspection-1' });
  });

  test('a filed activity remains visible when there is no draft to continue', () => {
    expect(deriveDailyActivity(
      [{ id: 'submitted', status: 'SUBMITTED' }],
      [{ id: 'open', status: 'OPEN' }],
      TODAY,
    )).toEqual([
      { kind: 'DPR', state: 'Filed today', action: 'View records', to: '/portal/dpr/my' },
      { kind: 'Inspection', state: 'Filed today', action: 'View records', to: '/portal/inspection/my' },
    ]);
  });

  test('reports both completed activity and an open draft for the same day', () => {
    expect(deriveDailyActivity(
      [{ id: 'draft', status: 'DRAFT' }, { id: 'submitted', status: 'SUBMITTED' }],
      [],
      TODAY,
    )[0]).toEqual({
      kind: 'DPR',
      state: 'Filed today · draft saved',
      action: 'Continue draft',
      to: '/portal/dpr/submit?draftId=draft',
    });
  });

  test('empty lists are actionable, while missing lists show a retry state', () => {
    expect(deriveDailyActivity([], [], TODAY).every((item) => item.state === 'No record yet')).toBe(true);
    expect(deriveDailyActivity(null, [], TODAY)[0]).toMatchObject({ state: "Couldn't load", action: 'Retry', failed: true });
  });

  test('a failure in one feed does not hide the other feed state', () => {
    const [dpr, inspection] = deriveDailyActivity(null, [{ id: 'i-1', status: 'OPEN' }], TODAY);
    expect(dpr).toMatchObject({ state: "Couldn't load", failed: true });
    expect(inspection).toMatchObject({ state: 'Filed today', action: 'View records' });
  });
});