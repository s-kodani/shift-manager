import { describe, expect, it } from 'vitest';
import type { ScheduleView } from '../../apps/web/product/api';
import { historyTarget, publicationBlockers, publicationEligibility, violationAdvice } from '../../apps/web/product/publication-guidance';
const person = '11111111-1111-4111-8111-111111111111';
const view = (status: string, overrides: Partial<ScheduleView['result']['validation']> = {}): ScheduleView => ({
  stale: false, publication: 'BLOCKED_A1', result: { assignments: [], validation: { status, violations: [], ...overrides } },
});
describe('publication guidance follows the candidate evidence', () => {
  it('allows shortage acknowledgement only after mandatory publication checks pass', () => {
    const shortage = view('VERIFIED', { generalShortage: 60 });
    expect(publicationEligibility(shortage)).toMatchObject({ ready: true, shortage: true });
    expect(publicationEligibility(shortage, true)).toMatchObject({ ready: false, shortage: true });
    for (const status of ['INVALID', 'HISTORY_UNVERIFIED', 'NOT_RUN']) {
      expect(publicationEligibility(view(status, { generalShortage: 60 }))).toMatchObject({ ready: false, shortage: true });
    }
    expect(publicationEligibility(view('VERIFIED', { roleRequirements: [{ id: 'phone-sv', shortagePersonMinutes: 60 }] })))
      .toMatchObject({ ready: true, shortage: true });
  });
  it('does not describe history-only or stale-only candidates as mandatory violations', () => {
    expect(publicationBlockers(view('HISTORY_UNVERIFIED', { missingHistory: [`${person}:2026-09-30`] })))
      .toEqual({ history: true, invalid: false, stale: false, unverified: false });
    expect(publicationBlockers(view('VERIFIED'), true)).toEqual({ history: false, invalid: false, stale: true, unverified: false });
    expect(publicationBlockers(view('VERIFIED'))).toEqual({ history: false, invalid: false, stale: false, unverified: false });
  });
  it('retains all applicable reasons and distinguishes unavailable verification from actual violations', () => {
    const candidate = view('INVALID', { missingHistory: [`${person}:2026-09-30`], violations: [`CONTRACT:${person}:2026-10-01`] });
    candidate.stale = true;
    expect(publicationBlockers(candidate)).toEqual({ history: true, invalid: true, stale: true, unverified: false });
    expect(publicationBlockers(view('NOT_RUN'))).toEqual({ history: false, invalid: false, stale: false, unverified: true });
    expect(publicationBlockers(view('FUTURE_STATUS', { missingHistory: ['unknown'] })).unverified).toBe(true);
    expect(publicationBlockers(view('INVALID')).invalid).toBe(true);
  });
  it('uses known codes and preserves unknown diagnostics without inventing a person or date', () => {
    expect(violationAdvice(`CONTRACT:${person}:2026-10-01`, [person])).toMatchObject({ staffId: person, date: '2026-10-01', fix: 'staff' });
    expect(violationAdvice(`EVENT_OVERLAP:${person}:2026-10-02:event`, [person])).toMatchObject({ title: '予定と休憩・取消が重なっています', fix: 'demand' });
    expect(violationAdvice(`WEEKLY_HOURS:${person}:2026-09-28:company`, [person])).toMatchObject({ date: '2026-09-28', fix: 'staff' });
    expect(violationAdvice('UNKNOWN_CODE:other:not-a-date', [person])).toMatchObject({ staffId: undefined, date: undefined, raw: 'UNKNOWN_CODE:other:not-a-date', fix: 'recompute' });
  });
  it('only links an actual staff/date pair, rejecting corrupt or impossible dates', () => {
    expect(historyTarget(`${person}:2026-09-30`)).toEqual({ staffId: person, date: '2026-09-30' });
    for (const input of ['missing', `${person}:2026-99-99`, `${person}:2026-02-30`, `${person}:2026-09-30:extra`]) expect(historyTarget(input)).toBeNull();
  });
});
