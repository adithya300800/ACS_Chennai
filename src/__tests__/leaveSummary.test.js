import { inclusiveDayCount, summariseLeave } from '../lib/leaveSummary.js';

describe('inclusiveDayCount', () => {
  test('counts both endpoints and rejects reversed ranges', () => {
    expect(inclusiveDayCount('2026-10-01', '2026-10-03')).toBe(3);
    expect(inclusiveDayCount('2026-10-03', '2026-10-01')).toBe(0);
  });
});

describe('summariseLeave', () => {
  test('counts approved days in the selected year and pending requests separately', () => {
    expect(summariseLeave([
      { status: 'APPROVED', startDate: '2025-12-30', endDate: '2026-01-02' },
      { status: 'APPROVED', startDate: '2026-03-10', endDate: '2026-03-10' },
      { status: 'APPROVED', startDate: '2025-03-10', endDate: '2025-03-12' },
      { status: 'PENDING', startDate: '2026-04-01', endDate: '2026-04-03' },
      { status: 'REJECTED', startDate: '2026-05-01', endDate: '2026-05-02' },
      { status: 'CANCELLED', startDate: '2026-06-01', endDate: '2026-06-02' },
    ], '2026-10-31')).toEqual({ daysTaken: 3, pendingCount: 1, year: '2026' });
  });

  test('treats missing input as an empty summary', () => {
    expect(summariseLeave(undefined, '2026-10-31')).toEqual({ daysTaken: 0, pendingCount: 0, year: '2026' });
  });
});