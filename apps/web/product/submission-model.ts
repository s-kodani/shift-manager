import { z } from 'zod';
import { staffMonth } from '../../api/src/input-contracts';
import { parseTimeInput as minute,formatTimeInput } from './time-input-model';

export type MonthInput=z.infer<typeof staffMonth>;
export type UnavailableRow={key:string;date:string;start:string;end:string};
export type PreferenceRow=UnavailableRow&{kind:MonthInput['preferences'][number]['kind'];patternId:string};
export function submissionDraft(value:MonthInput) {
  return {unavailable:value.unavailable.map(v=>({...v,key:crypto.randomUUID(),start:formatTimeInput(v.start),end:formatTimeInput(v.end)})),
    preferences:value.preferences.map(v=>({key:crypto.randomUUID(),date:v.date,kind:v.kind,patternId:v.patternId??'',start:v.start===undefined?'':formatTimeInput(v.start),end:v.end===undefined?'':formatTimeInput(v.end)}))};
}
export function submissionPayload(month:string,unavailable:UnavailableRow[],preferences:PreferenceRow[]) {
  try {
    const value=staffMonth.parse({unavailable:unavailable.map(v=>({date:v.date,start:minute(v.start),end:minute(v.end)})),
      preferences:preferences.map(v=>({date:v.date,kind:v.kind,...(v.kind==='pattern'?{patternId:v.patternId}:v.kind==='window'?{start:minute(v.start),end:minute(v.end)}:{})}))});
    if([...value.unavailable,...value.preferences].some(v=>!v.date.startsWith(month+'-')||('start' in v&&v.start!==undefined&&v.start>=v.end!)))throw new Error('INVALID_INTERVAL');
    if(new Set(value.preferences.map(v=>v.date+':'+v.kind)).size!==value.preferences.length)throw new Error('DUPLICATE_PREFERENCE');
    return value;
  } catch {
    throw new Error('時刻は数字4桁のHHMM（例：0930）で、日付は対象月内、開始は終了より前にしてください。同じ日の同じ種類の希望は1件だけ登録できます。時間帯の希望は30分単位、勤務不可は分単位です。');
  }
}
export function jstWindowTime(value:string) {
  if(!/^20\d\d-\d\d-\d\dT\d\d:\d\d$/.test(value))throw new Error('受付終了日時を日本時間で入力してください。');
  const result=Date.parse(value+':00+09:00');
  if(!Number.isSafeInteger(result)||new Date(result+9*3600000).toISOString().slice(0,16)!==value)throw new Error('受付終了日時を確認してください。');
  return result;
}
