import { expect, it } from 'vitest';
import { demandCoverage } from '../../apps/api/src/demand-coverage';
const tasks = [{id:'phone',kind:'general' as const,minimumLevel:0,minimumMinutes:0,capacities:[]},
  {id:'chat',kind:'general' as const,minimumLevel:0,minimumMinutes:0,capacities:[]},
  {id:'sv',kind:'dedicated' as const,minimumLevel:0,minimumMinutes:0,capacities:[]}];
it('uses company weekdays, month boundaries and every general task; outside rows do not fill a gap',()=>{
  const result=demandCoverage('2026-02',{weekdays:[0],start:540,end:600},{slotMinutes:30,tasks},[
    {date:'2026-02-01',start:540,end:570,taskId:'phone',direct:0,calculated:10},
    {date:'2026-02-01',start:540,end:570,taskId:'chat',direct:null,calculated:0},
    {date:'2026-02-02',start:540,end:570,taskId:'phone',direct:1,calculated:null},
    {date:'2026-02-01',start:600,end:630,taskId:'chat',direct:1,calculated:null},
    {date:'2026-02-01',start:570,end:600,taskId:'phone',direct:null,calculated:null},
  ]);
  expect(result).toMatchObject({expectedSlots:16,missingSlots:14});
  expect(result.examples[0]).toEqual({date:'2026-02-01',start:570,end:600,taskId:'phone'});
  expect(result.examples).toHaveLength(12);
});
it('includes leap day and overlapping clock-aligned 60 minute boundary slots',()=>{
  const result=demandCoverage('2028-02',{weekdays:[2],start:510,end:570},{slotMinutes:60,tasks:tasks.slice(0,1)},[]);
  expect(result.expectedSlots).toBe(10); // Five Tuesdays including February 29.
  expect(result.examples.at(-1)).toEqual({date:'2028-02-29',start:540,end:600,taskId:'phone'});
});
it.each([
  [0, ['2026-02-01','2026-02-08','2026-02-15','2026-02-22']],
  [1, ['2026-02-02','2026-02-09','2026-02-16','2026-02-23']],
  [2, ['2026-02-03','2026-02-10','2026-02-17','2026-02-24']],
  [3, ['2026-02-04','2026-02-11','2026-02-18','2026-02-25']],
  [4, ['2026-02-05','2026-02-12','2026-02-19','2026-02-26']],
  [5, ['2026-02-06','2026-02-13','2026-02-20','2026-02-27']],
  [6, ['2026-02-07','2026-02-14','2026-02-21','2026-02-28']],
] as const)('uses saved weekday %i (Sunday=0) without including unselected days', (weekday, dates)=>{
  const result=demandCoverage('2026-02',{weekdays:[weekday],start:540,end:570},{slotMinutes:30,tasks:tasks.slice(0,1)},[]);
  expect(result).toEqual({expectedSlots:4,missingSlots:4,examples:dates.map(date=>({date,start:540,end:570,taskId:'phone'}))});
});
it('checks Monday through Friday without requiring Saturday or Sunday demand',()=>{
  const dates=['02','03','04','05','06','09','10','11','12','13','16','17','18','19','20','23','24','25','26','27'];
  const demand=dates.map(day=>({date:`2026-02-${day}`,start:540,end:570,taskId:'phone',direct:0,calculated:null}));
  expect(demandCoverage('2026-02',{weekdays:[1,2,3,4,5],start:540,end:570},{slotMinutes:30,tasks:tasks.slice(0,1)},demand))
    .toEqual({expectedSlots:20,missingSlots:0,examples:[]});
});
it('does not require demand when there are no operating weekdays or no general tasks',()=>{
  expect(demandCoverage('2026-10',{weekdays:[],start:0,end:1440},{slotMinutes:30,tasks},[]).expectedSlots).toBe(0);
  expect(demandCoverage('2026-10',{weekdays:[0],start:0,end:1440},{slotMinutes:60,tasks:tasks.slice(2)},[]).expectedSlots).toBe(0);
});
