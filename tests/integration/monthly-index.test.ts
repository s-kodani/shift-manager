import {expect,it} from 'vitest';
import {indexMonthlyAssignments,indexStaffNames} from '../../apps/web/product/monthly-index';

it('a full reversed 500-person month selects the same rows as the prior display for every staff/date cell',()=>{
 const rows=Array.from({length:500},(_,i)=>Array.from({length:31},(_,day)=>({staffId:'fictional-'+i,date:'2026-10-'+String(day+1).padStart(2,'0'),marker:i*31+day}))).flat().reverse();
 const people=indexMonthlyAssignments(rows);
 // Establish the expected full table once, without repeating an expensive find
 // in production. Selected boundaries are also compared to the previous lookup.
 for(const row of rows)expect(people.get(row.staffId)?.get(row.date)).toBe(row);
 for(const id of ['fictional-0','fictional-250','fictional-499'])for(const date of ['2026-10-01','2026-10-31'])
  expect(people.get(id)?.get(date)).toBe(rows.find(row=>row.staffId===id&&row.date===date));
 expect(people.get('absent')).toBeUndefined();expect(people.get('fictional-0')?.get('2026-11-01')).toBeUndefined();
});
it('missing data, duplicate boundary rows and identifier separators retain the original first-match behavior',()=>{
 expect(indexMonthlyAssignments(null).size).toBe(0);expect(indexMonthlyAssignments([]).size).toBe(0);
 const rows=[{staffId:'a:2026-10-01',date:'2026-10-02',shift:null},{staffId:'a',date:'2026-10-01',shift:'first'},
  {staffId:'a',date:'2026-10-01',shift:'duplicate'}];
 const people=indexMonthlyAssignments(rows);
 expect(people.get('a')?.get('2026-10-01')).toBe(rows[1]);expect(people.get('a:2026-10-01')?.get('2026-10-02')).toBe(rows[0]);
 const names=indexStaffNames([{id:'a',name:'架空名'},{id:'a',name:'重複名'},{id:'b',name:'架空名'}]);
 expect(names.get('a')).toBe('架空名');expect(names.get('b')).toBe('架空名');expect(names.get('missing')??'当時のスタッフ').toBe('当時のスタッフ');
 expect(indexStaffNames([{id:'a',name:'変更後'}]).get('a')).toBe('変更後');
});
