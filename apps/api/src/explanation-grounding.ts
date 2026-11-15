import { z } from 'zod';
import type { OptimizerInput } from '../../../packages/contracts/optimizer-input.generated';
import { generatedSummary,type ExplanationFact } from './explanation-contract';

const amount=z.number().int().nonnegative().safe();
const interval=z.object({date:z.string(),taskId:z.string(),start:amount.max(1439),end:amount.max(1440),required:amount,capacity:amount,shortage:amount,surplus:amount,
  processingPeople:amount.optional(),ordinaryPeople:amount.optional(),rolePeople:z.record(z.string(),amount).optional()});
const roleInterval=z.object({start:amount.max(1439),end:amount.max(1440),ordinaryPeople:amount,required:amount,actual:amount,shortage:amount});
const metrics=z.object({status:z.enum(['VERIFIED','HISTORY_UNVERIFIED']),scope:z.literal('multi-task-v1'),violations:z.array(z.string()).length(0),missingHistory:z.array(z.string()),
  generalShortage:amount,roleSameShortage:amount,units:z.object({capacityScale:amount.positive(),coverage:z.literal('scaled-person-minute'),missed:z.literal('preference-item')}),
  preferences:z.array(z.object({staffId:z.string(),date:z.string(),kind:z.string(),fulfilled:z.boolean()})),intervals:z.array(interval),
  roleRequirements:z.array(z.object({id:z.string(),shortagePersonMinutes:amount,intervals:z.array(roleInterval).optional()})),
  daily:z.array(z.object({workedMinutes:amount,preparationMinutes:amount,eventMinutes:amount,processedMinutes:amount,breakMinutes:amount.optional(),cancelledMinutes:amount.optional()}))});
const status=z.object({status:z.enum(['VERIFIED','HISTORY_UNVERIFIED','INVALID','NOT_RUN']),violations:z.array(z.string())});
export const PROMPT_VERSION='extractive-ja-v1';
export const time=(m:number)=>`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
// Exact decimal expansion, or a fraction for non-terminating coefficients.
export function exactAmount(n:number,scale=1):string {
  let numerator=BigInt(n),denominator=BigInt(scale),a=numerator,b=denominator;
  while(b){const r=a%b;a=b;b=r;}numerator/=a||1n;denominator/=a||1n;
  let remaining=denominator;while(remaining%2n===0n)remaining/=2n;while(remaining%5n===0n)remaining/=5n;
  if(remaining!==1n)return `${numerator}/${denominator}`;
  let text=String(numerator/denominator),r=numerator%denominator;if(!r)return text;
  text+='.';while(r){r*=10n;text+=String(r/denominator);r%=denominator;}return text;
}
export function groundFacts(input:OptimizerInput,validation:unknown,solverStatus:string,hasAssignments:boolean) {
  const facts:ExplanationFact[]=[],add=(id:string,category:string,text:string,section:string,values:ExplanationFact['values']={},index?:number)=>facts.push({id,category,text,reference:{section,...(index===undefined?{}:{index})},values});
  const parsed=status.safeParse(validation),validationStatus=parsed.success?parsed.data.status:'UNAVAILABLE';
  const states:Record<string,string>={OPTIMAL:'探索した各評価段階の最良値を証明しています。',FEASIBLE:'配置案はありますが、最良値は未証明です。',UNKNOWN:'探索内で配置案を発見できませんでした。実行不可能とは確定していません。',INFEASIBLE:'指定条件の解がないことをソルバーが証明しました。',MODEL_INVALID:'モデルの検査に失敗しました。',MANUAL:'手動編集案です。最適性は評価していません。'};
  add('solver','status',states[solverStatus]??'探索状態の根拠を取得できていません。','solverStatus',{solverStatus});
  const labels:Record<string,string>={VERIFIED:'対象の必須条件を独立チェッカーで検証済みです。',HISTORY_UNVERIFIED:'必要な勤務履歴が不足する参考案です。公開できません。',INVALID:'必須条件違反を検出しています。公開できません。',NOT_RUN:'配置案の独立検証は実行されていません。',UNAVAILABLE:'検証結果の根拠を取得できていません。'};
  add('validation','status',labels[validationStatus],'validation.status',{validationStatus});
  add('time','condition',`需要の配置枠は${input.slotMinutes}分です。不足は分単位で積算します。`,'input.slotMinutes',{slotMinutes:input.slotMinutes});
  add('controls','condition',input.mode==='reallocation'?'公開後の再配置では、取消を除く出退勤と公開済み休憩を維持します。':'固定された勤務パターン・出退勤・休憩を維持し、勤務不可例外は許可済みの範囲に限ります。','input.mode',{locks:input.locks.length,exceptions:input.exceptions.length,mode:input.mode});
  add('fixed','condition',`この入力には固定${input.locks.length}件、理由を記録した勤務不可例外${input.exceptions.length}件、研修・会議${input.events.length}件があります。`,'input.locks',{locks:input.locks.length,exceptions:input.exceptions.length,events:input.events.length});
  const b=input.breakRule;
  add('break-rule','condition',`休憩は${b.basis==='worked'?'実勤務':'拘束'}時間が${b.threshold}分を超える場合に${b.requiredMinutes}分必要です。自動休憩は必要量と一致し、固定休憩は必要量以上とします。`,'input.breakRule',{basis:b.basis,threshold:b.threshold,requiredMinutes:b.requiredMinutes,afterStart:b.afterStart,beforeEnd:b.beforeEnd});
  add('cause','unknown','不足の原因や、条件変更による改善量は特定していません。比較には別の計算・検証が必要です。','analysis');
  const taskAliases=input.tasks.map((t,i)=>({alias:`業務${i+1}`,id:t.id})),roleAliases=input.roles.map((r,i)=>({alias:`担当区分${i+1}`,id:r.id}));
  const task=(id:string)=>taskAliases.find(t=>t.id===id)?.alias??'未照合の業務',role=(id:string)=>roleAliases.find(r=>r.id===id)?.alias??'未照合の担当区分';
  input.tasks.forEach((t,index)=>{
    const qualified=input.staff.filter(s=>s.skills.some(x=>x.taskId===t.id&&x.level>=t.minimumLevel)).length;
    add(`skill-${index}`,'condition',`${task(t.id)}の最低習熟度は${t.minimumLevel}で、習熟度条件を満たすスタッフは${qualified}人です。この人数は時間帯別の勤務可能人数ではありません。`,'input.tasks',{taskId:t.id,minimumLevel:t.minimumLevel,qualifiedPeople:qualified},index);
  });
  const m=metrics.safeParse(validation);let metricsAvailable=false;
  if(hasAssignments&&m.success&&m.data.units.capacityScale===input.capacityScale){
    const v=m.data,expectedPreferences=input.staff.flatMap(s=>s.preferences.map(p=>`${s.id}:${p.date}:${p.kind}`)),actual=v.preferences.map(p=>`${p.staffId}:${p.date}:${p.kind}`);
    const seen=new Map<string,number>();let coherent=(v.status==='VERIFIED')===(v.missingHistory.length===0);
    for(const c of v.intervals){
      const key=c.date+':'+c.taskId,previous=seen.get(key)??0;seen.set(key,c.end);
      const people=c.rolePeople?Object.values(c.rolePeople).reduce((n,x)=>n+x,0):null;
      coherent&&=c.start<c.end&&c.start>=previous&&c.date.startsWith(input.month+'-')&&input.tasks.some(t=>t.id===c.taskId&&t.kind==='general')&&c.shortage===Math.max(0,c.required-c.capacity)&&c.surplus===Math.max(0,c.capacity-c.required);
      if(c.processingPeople!==undefined)coherent&&=people!==null&&c.ordinaryPeople!==undefined&&c.processingPeople===c.ordinaryPeople+people&&Object.keys(c.rolePeople!).every(r=>input.roles.some(x=>x.id===r));
    }
    const actualPreferences=new Set(actual);
    coherent&&=v.generalShortage===v.intervals.reduce((n,c)=>n+c.shortage*(c.end-c.start),0)&&expectedPreferences.length===actual.length&&actualPreferences.size===actual.length&&expectedPreferences.every(k=>actualPreferences.has(k));
    coherent&&=v.roleRequirements.length===input.roleRequirements.length&&new Set(v.roleRequirements.map(r=>r.id)).size===v.roleRequirements.length;
    for(const r of v.roleRequirements){const condition=input.roleRequirements.find(x=>x.id===r.id);coherent&&=!!condition;if(!condition)continue;
      if(r.intervals){let cursor=condition.start;for(const c of r.intervals){const ratio=c.ordinaryPeople*condition.ratioNumerator/condition.ratioDenominator,required=Math.max(condition.minimum,condition.rounding==='ceil'?Math.ceil(ratio):Math.floor(ratio));coherent&&=c.start===cursor&&c.start<c.end&&c.end<=condition.end&&c.required===required&&c.shortage===Math.max(0,c.required-c.actual);cursor=c.end;}coherent&&=cursor===condition.end&&r.shortagePersonMinutes===r.intervals.reduce((n,c)=>n+c.shortage*(c.end-c.start),0);}
    }
    coherent&&=v.roleSameShortage===v.roleRequirements.reduce((n,r)=>n+(input.roleRequirements.find(x=>x.id===r.id)?.priority==='same'?r.shortagePersonMinutes*input.capacityScale:0),0);
    if(coherent){
      metricsAvailable=true;
      const fulfilled=v.preferences.filter(p=>p.fulfilled).length;
      add('preferences','preference',actual.length?`希望は${actual.length}件中${fulfilled}件充足し、${actual.length-fulfilled}件が未充足です。`:'登録された希望はありません。希望充足率は表示しません。','validation.preferences',{total:actual.length,fulfilled,missed:actual.length-fulfilled});
      add('general-total','coverage',`一般業務の不足積算は${exactAmount(v.generalShortage,input.capacityScale)}人相当・分です。`,'validation.generalShortage',{scaledPersonMinutes:v.generalShortage,capacityScale:input.capacityScale});
      v.intervals.map((c,index)=>({c,index})).filter(x=>x.c.shortage>0).sort((a,b)=>b.c.shortage*(b.c.end-b.c.start)-a.c.shortage*(a.c.end-a.c.start)||a.index-b.index).forEach(({c,index},i)=>{
        add(`general-${i}`,'coverage',`${c.date} ${time(c.start)}〜${time(c.end)}の${task(c.taskId)}は、必要${exactAmount(c.required,input.capacityScale)}人相当、配置能力${exactAmount(c.capacity,input.capacityScale)}人相当、不足${exactAmount(c.shortage,input.capacityScale)}人相当です。`,'validation.intervals',{date:c.date,start:c.start,end:c.end,taskId:c.taskId,required:c.required,capacity:c.capacity,shortage:c.shortage,capacityScale:input.capacityScale},index);
        if(c.processingPeople!==undefined)add(`people-${i}`,'people',`同じ区間で一般業務を処理中の実人数は${c.processingPeople}人、うちSV・リーダーなどを兼任中の人を除く実人数は${c.ordinaryPeople}人です。`,'validation.intervals',{processingPeople:c.processingPeople,ordinaryPeople:c.ordinaryPeople!},index);
      });
      for(const [index,r] of v.roleRequirements.entries()){
        const c=input.roleRequirements.find(x=>x.id===r.id)!;
        add(`role-${index}`,'role',`${c.date} ${time(c.start)}〜${time(c.end)}の${role(c.roleId)}（${c.taskId?task(c.taskId):'全業務'}）の不足積算は${r.shortagePersonMinutes}人・分です。`,'validation.roleRequirements',{id:r.id,roleId:c.roleId,date:c.date,start:c.start,end:c.end,shortagePersonMinutes:r.shortagePersonMinutes,priority:c.priority},index);
        for(const [j,x] of (r.intervals??[]).entries())if(x.shortage>0)add(`role-${index}-${j}`,'role',`${time(x.start)}〜${time(x.end)}の${role(c.roleId)}は、必要${x.required}人、兼任中${x.actual}人、不足${x.shortage}人です。比率の分母は一般業務の実稼働${x.ordinaryPeople}人です。`,'validation.roleRequirements',{id:r.id,date:c.date,...x},index);
      }
      const daily=v.daily.reduce((n,d)=>({worked:n.worked+d.workedMinutes,event:n.event+d.eventMinutes,preparation:n.preparation+d.preparationMinutes}),{worked:0,event:0,preparation:0});
      add('work','condition',`検証した勤務量は${daily.worked}分で、研修・会議${daily.event}分と準備・移動${daily.preparation}分を含みます。休憩・取消は勤務量に含みません。`,'validation.daily',daily);
      if(v.daily.every(d=>d.breakMinutes!==undefined&&d.cancelledMinutes!==undefined)){
        const totals=v.daily.reduce((n,d)=>({break:n.break+d.breakMinutes!,cancelled:n.cancelled+d.cancelledMinutes!}),{break:0,cancelled:0});
        add('non-work','condition',`取消後に残る休憩は${totals.break}分、取り消された拘束区間は${totals.cancelled}分です。`,'validation.daily',totals);
      }
      add('eligibility','condition',`最低習熟度は担当可否、処理能力係数は人数換算に使います。担当区分の比率の分母から、SV・リーダーなどを兼任中の人を除きます。`,'input.tasks');
    }
  }
  if(!metricsAvailable)add('metrics-unavailable','unknown','不足・希望充足の詳細を照合できていないため、数値の説明は表示しません。','validation');
  // Preserve status/controls and role/preference coverage before truncating long
  // lists; the original full checker result stays accessible in the results UI.
  const important=facts.filter(f=>f.id==='general-total'||!f.id.startsWith('general-')&&!f.id.startsWith('people-'));
  const detail=facts.filter(f=>!important.includes(f));const ordered=[...important,...detail];
  return {facts:ordered.slice(0,256),omittedFacts:Math.max(0,ordered.length-256),metricsAvailable,validationStatus,taskAliases,roleAliases};
}
export function summaryPacket(facts:ExplanationFact[]) {
  const primary=facts.filter(f=>['solver','validation','preferences','general-total','cause'].includes(f.id));
  const important=facts.filter(f=>f.category==='role'||f.category==='coverage').filter(f=>!primary.includes(f)).slice(0,12);
  return [...primary,...important].slice(0,16).map(({id,text})=>({id,text}));
}
export function validateSummary(raw:unknown,facts:ExplanationFact[]) {
  const parsed=generatedSummary.safeParse(raw);if(!parsed.success)return null;const s=parsed.data;
  const allowed=summaryPacket(facts),texts=s.factIds.map(id=>allowed.find(f=>f.id===id)?.text);
  if(new Set(s.factIds).size!==s.factIds.length||!s.factIds.includes('solver')||!s.factIds.includes('validation')||texts.some(t=>!t)||s.summary!==texts.join('\n'))return null;
  return s;
}
export function templateSummary(facts:ExplanationFact[]) {
  const ids=['solver','validation','general-total','preferences','metrics-unavailable'];const selected=ids.map(id=>facts.find(f=>f.id===id)).filter(f=>!!f);
  return {summary:selected.map(f=>f.text).join('\n'),factIds:selected.map(f=>f.id)};
}
