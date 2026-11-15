import { expect,it } from 'vitest';
import { submissionDraft,submissionPayload,jstWindowTime } from '../../apps/web/product/submission-model';
it('本人フォームは分単位の勤務不可・24:00と別々の希望を保持し、画面のキーや隠れた値を送信しない',()=>{
  const value={unavailable:[{date:'2026-10-01',start:607,end:617},{date:'2026-10-02',start:0,end:1440}],preferences:[{date:'2026-10-01',kind:'work' as const},{date:'2026-10-01',kind:'pattern' as const,patternId:'day'},{date:'2026-10-01',kind:'window' as const,start:600,end:1020}]};
  const draft=submissionDraft(value);expect(submissionPayload('2026-10',draft.unavailable,draft.preferences)).toEqual(value);
  draft.preferences[1].kind='off';expect(submissionPayload('2026-10',draft.unavailable,draft.preferences).preferences[1]).toEqual({date:'2026-10-01',kind:'off'});
  expect(draft.unavailable[1].end).toBe('2400');
});
it('本人フォームは月外・不正日時・逆転区間・30分外の希望・同じ種類の重複を拒否する',()=>{
  const row={key:'fictional',date:'2026-10-01',start:'1000',end:'1700',kind:'window' as const,patternId:''};
  for(const patch of [{date:'2026-11-01'},{date:'2026-10-32'},{start:'1007'},{start:'1700'},{start:'2500'}])expect(()=>submissionPayload('2026-10',[],[{...row,...patch}])).toThrow();
  expect(()=>submissionPayload('2026-10',[],[row,{...row,key:'second'}])).toThrow();
});
it('管理者の追加受付日時は明示的な日本時間として解釈し、無効な月末を補正して受理しない',()=>{
  expect(jstWindowTime('2028-02-29T23:59')).toBe(Date.parse('2028-02-29T14:59:00Z'));
  for(const value of ['2027-02-29T23:59','2026-10-01T24:00','2026-10-01T10:00Z','2026-10-01T10:00:00','invalid'])expect(()=>jstWindowTime(value)).toThrow();
});
