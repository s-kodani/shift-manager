import { describe, expect, it } from 'vitest';
import { readinessResponse, readinessItemIds } from '../../apps/api/src/readiness-contract';
const response = () => ({ companyId: '11111111-1111-4111-8111-111111111111', teamId: '22222222-2222-4222-8222-222222222222', month: '2026-10', inputRevision: 0, draftRevision: 0, canCompute: true,
  items: readinessItemIds.map(id => ({ id, status: 'complete', required: !['history','preferences'].includes(id), section: 'schedule', message: '確認済み' })) });
describe('readiness response boundary', () => {
  it('allows only a demand coverage warning to remain calculable', () => {
    const value = response();
    const warning = {...value.items[5]!,status:'warning',code:'DEMAND_COVERAGE_MISSING',
      demandCoverage:{expectedSlots:2,missingSlots:1,examples:[{date:'2026-10-01',start:540,end:570,taskId:'phone'}]}};
    value.items[5]=warning;
    expect(readinessResponse.safeParse(value).success).toBe(true);
    expect(readinessResponse.safeParse({...value,canCompute:false}).success).toBe(false);
    expect(readinessResponse.safeParse({...value,items:value.items.map(i=>i===warning?{...i,id:'contracts'}:i)}).success).toBe(false);
    expect(readinessResponse.safeParse({...value,items:value.items.map(i=>i===warning?{...i,code:'OTHER_WARNING'}:i)}).success).toBe(false);
    const contracts=response();contracts.items[4]={...contracts.items[4]!,...warning,id:'contracts'};
    expect(readinessResponse.safeParse(contracts).success).toBe(false);
  });
  it('allows missing optional history but rejects permission to compute with missing required input', () => {
    const value = response(); value.items[7]!.status = 'missing'; expect(readinessResponse.safeParse(value).success).toBe(true);
    value.items[0]!.status = 'missing'; expect(readinessResponse.safeParse(value).success).toBe(false);
    value.canCompute = false; expect(readinessResponse.safeParse(value).success).toBe(true);
  });
  it('rejects missing or duplicated checks and unknown result fields', () => {
    const value = response(); value.items[0] = value.items[1]!; expect(readinessResponse.safeParse(value).success).toBe(false);
    expect(readinessResponse.safeParse({ ...response(), extra: true }).success).toBe(false);
    expect(readinessResponse.safeParse({ ...response(), items: response().items.slice(1) }).success).toBe(false);
  });
  it('rejects invalid revisions and months', () => {
    expect(readinessResponse.safeParse({ ...response(), inputRevision: -1 }).success).toBe(false);
    expect(readinessResponse.safeParse({ ...response(), draftRevision: 0.5 }).success).toBe(false);
    expect(readinessResponse.safeParse({ ...response(), month: '2026-13' }).success).toBe(false);
  });
});
