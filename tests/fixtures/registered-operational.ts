// Fictional acceptance setup; product HTTP never imports it.
import {provisionCompany,createTeam,saveCalendarSettings} from '../../apps/api/src/product';
import {saveInputVersion} from '../../apps/api/src/input-versions';
import type {InputKind} from '../../apps/api/src/input-contracts';
import {staffCsvColumns} from '../../apps/api/src/staff-csv-contract';
import {buildStaffCsvPreview,applyStaffCsv} from '../../apps/api/src/staff-csv';
import {saveHistory} from '../../apps/api/src/work-history';
import {createInputSnapshot,readInputSnapshot} from '../../apps/api/src/input-snapshots';
import type {OptimizerInput,OptimizerAssignments} from '../../packages/contracts/optimizer-input.generated';

export type RegisteredRequest=(path:string,body?:object)=>Promise<Response>;
export type RegisteredHttpOptions={
 authenticate:(issued:Awaited<ReturnType<typeof provisionCompany>>,email:string)=>Promise<RegisteredRequest>;
 firstStaffIssued:(email:string,staffId:string,password:string)=>Promise<void>;
};
// Local browser setup receives only the first fictional credentials transiently.
// Registration is direct setup, not evidence of HTTP/UI master registration.
export type RegisteredUiOptions={
 companyIssued:(issued:Awaited<ReturnType<typeof provisionCompany>>,email:string)=>void;
 firstStaffIssued:(email:string,staffId:string,password:string)=>void;
};
export async function registeredOperationalFixture(env:Pick<Env,'DB'|'INPUTS'>,source:{input:OptimizerInput;assignments:OptimizerAssignments},http?:RegisteredHttpOptions,ui?:RegisteredUiOptions,companyName='架空全月登録検証企業') {
 if(http&&ui)throw Error('REGISTERED_FIXTURE_MODE_CONFLICT');
 const d=source.input;
 if(d.tenantId!=='fictional-company-a'||d.staff.length>500||d.staff.length<10)throw Error('FICTIONAL_OPERATIONAL_FIXTURE_REQUIRED');
 const adminEmail=crypto.randomUUID()+'@example.invalid';
 const company=await provisionCompany(env.DB,{name:companyName,adminName:'架空管理者',adminEmail});
 const companyId=company.companyId,userId=company.userId;
 let revision=0;
 try {
  ui?.companyIssued(company,adminEmail);
  const request=http?await http.authenticate(company,adminEmail):null;
  // The original direct-function fixture is explicitly separate from HTTP/auth.
  if(!request)await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(userId).run();
  const invoke=async<T>(path:string,body:object|undefined,direct:()=>Promise<T>):Promise<T>=>{
   if(!request)return direct();
   const response=await request(path,body);
   if(response.status!==200)throw Error('REGISTERED_HTTP_FAILED_'+response.status);
   return await response.json() as T;
  };
  const base='/api/companies/'+companyId;
  const teamCommand={operationId:crypto.randomUUID(),expectedRevision:revision++,name:'架空全月チーム'};
  const team=(await invoke(base+'/teams',teamCommand,()=>createTeam(env.DB,companyId,userId,teamCommand))).teamId;
  const employmentId=crypto.randomUUID(),apiContract={...d.staff[0].contract,weekdays:d.staff[0].contract.weekdays.map(day=>(day+1)%7)};
  const rule=({...(({id,...r})=>r)(d.staff[0].rules[0])});
  const save=async(kind:InputKind,payload:unknown,entity=team,staff:string|null=null)=>{
   const global=kind==='company_policy'||kind==='employment_policy';
   const path=kind==='company_policy'?'/inputs/company-policy':kind==='employment_policy'?'/inputs/employment/'+entity:
    '/inputs/teams/'+team+(kind==='team_config'?'/config':kind==='staff_month'?'/staff/'+staff+'/month':'/planning');
   const command={operationId:crypto.randomUUID(),expectedRevision:revision,effectiveFrom:d.month,payload};
   const result=await invoke(base+path,command,()=>saveInputVersion(env.DB,{company:companyId,team:global?null:team,staff,kind,entity},userId,command,env.INPUTS));
   revision=result.revision;
  };
  const calendarCommand={operationId:crypto.randomUUID(),expectedRevision:revision,effectiveFrom:d.month,
   settings:{weekStart:(d.weekStart+1)%7,deadlineDay:20,halfDayDivider:720,roleRounding:'ceil' as const}};
  const calendar=await invoke(base+'/calendar-settings',calendarCommand,()=>saveCalendarSettings(env.DB,companyId,userId,calendarCommand));revision=calendar.revision;
  await save('company_policy',{rule,contract:apiContract,skillLevels:[{level:1,name:'架空標準'}],breakRule:d.breakRule},companyId);
  await save('employment_policy',{name:'架空雇用区分',rule,contract:apiContract},employmentId);
  const priorities=new Map(d.roleRequirements.map(r=>[r.taskId,r.priority]));
  await save('team_config',{slotMinutes:d.slotMinutes,priority:d.priority,capacityScale:d.capacityScale,patterns:d.patterns,roles:d.roles,transitions:d.transitions,
   tasks:d.tasks.map(t=>({...t,capacities:[{level:1,capacity:d.staff[0].skills.find(s=>s.taskId===t.id)!.capacity}]})),
   rolePolicies:[{taskId:null,priority:'first'},...d.tasks.filter(t=>t.kind==='general').map(t=>({taskId:t.id,priority:priorities.get(t.id)!}))]});
  const staffIds=new Map<string,string>(),numbers=new Map(d.staff.map((s,i)=>['fixture-'+String(i+1).padStart(4,'0'),s.id]));
  const time=(n:number)=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
  const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
  for(let offset=0;offset<d.staff.length;offset+=100){
   let firstEmail='';
   const rows=d.staff.slice(offset,offset+100).map((person,index)=>{
    const personal=person.rules[2],values:Record<string,string>={staff_number:'fixture-'+String(offset+index+1).padStart(4,'0'),name:'架空スタッフ'+String(offset+index+1).padStart(4,'0'),email:crypto.randomUUID()+'@example.invalid',employment_type_id:employmentId,
     weekdays:person.contract.weekdays.map(day=>(day+1)%7).join(';'),start:time(person.contract.start),end:time(person.contract.end),daily_max:String(personal.dailyMax),weekly_max:String(personal.weeklyMax),monthly_min:String(personal.monthlyMin),monthly_max:String(personal.monthlyMax),min_days:String(personal.minDays),min_off:String(personal.minOff),max_consecutive:String(personal.maxConsecutive),
     skills:JSON.stringify(person.skills.map(({capacity,...s})=>s)),role_ids:JSON.stringify(person.roleIds)};
    if(index===0)firstEmail=values.email;
    return staffCsvColumns.map(c=>quote(values[c])).join(',');
   });
   const c={month:d.month,expectedRevision:revision,csv:staffCsvColumns.join(',')+'\n'+rows.join('\n')};
   const preview=await invoke(base+'/inputs/teams/'+team+'/staff-csv/preview',c,async()=>(await buildStaffCsvPreview(env.DB,companyId,team,userId,c)).preview);
   if(preview.added!==rows.length||preview.rows.some(r=>r.errors.length))throw Error('REGISTERED_FIXTURE_PREVIEW_FAILED');
   const applyCommand={...c,operationId:crypto.randomUUID(),previewSha256:preview.previewSha256};
   const applied=await invoke(base+'/inputs/teams/'+team+'/staff-csv/apply',applyCommand,()=>applyStaffCsv(env.DB,companyId,team,userId,applyCommand));
   revision=applied.receipt.revision;
   for(const r of applied.receipt.rows)staffIds.set(numbers.get(r.staffNumber)!,r.staffId);
   if(offset===0&&http){const first=applied.initialPasswords.find(p=>p.staffNumber==='fixture-0001');if(!first)throw Error('FIRST_STAFF_CREDENTIAL_MISSING');await http.firstStaffIssued(firstEmail,staffIds.get(d.staff[0].id)!,first.initialPassword);}
   if(offset===0&&ui){const first=applied.initialPasswords.find(p=>p.staffNumber==='fixture-0001');if(!first)throw Error('FIRST_STAFF_CREDENTIAL_MISSING');ui.firstStaffIssued(firstEmail,staffIds.get(d.staff[0].id)!,first.initialPassword);}
   // Initial passwords stay transient and are never returned, logged or saved.
  }
  const sid=(id:string)=>{const mapped=staffIds.get(id);if(!mapped)throw Error('FIXTURE_STAFF_MAPPING_MISSING');return mapped;};
  for(const person of d.staff)await save('staff_month',{unavailable:person.unavailable,preferences:person.preferences},sid(person.id),sid(person.id));
  await save('planning',{demand:d.demand,events:d.events.map(e=>({...e,staffIds:e.staffIds.map(sid)})),roleRequirements:d.roleRequirements.map(({rounding,priority,...r})=>r)});
  const history=d.history.map(r=>({...r,staffId:sid(r.staffId),evidence:'架空の確認済み境界勤務'}));
  for(let offset=0;offset<history.length;offset+=500){const command={operationId:crypto.randomUUID(),expectedRevision:revision,month:d.month,records:history.slice(offset,offset+500)};const h=await invoke(base+'/inputs/teams/'+team+'/history',command,()=>saveHistory(env.DB,companyId,team,userId,command));revision=h.revision;}
  const snapshotId=crypto.randomUUID(),snapshotCommand={operationId:snapshotId,expectedRevision:revision,month:d.month};
  await invoke(base+'/inputs/teams/'+team+'/snapshots',snapshotCommand,()=>createInputSnapshot(env.DB,env.INPUTS,companyId,team,userId,snapshotCommand));
  const frozen=await invoke(base+'/inputs/teams/'+team+'/snapshots/'+snapshotId,undefined,()=>readInputSnapshot(env.DB,env.INPUTS,companyId,team,userId,snapshotId,true));
  return {companyId,userId,team,revision,snapshotId,frozen,staffIds,
   manual:{assignments:source.assignments.map(a=>({...a,staffId:sid(a.staffId)})),locks:d.locks.map(l=>({...l,staffId:sid(l.staffId)})),exceptions:d.exceptions.map(e=>({...e,staffId:sid(e.staffId)}))}};
 } catch(error){await disableRegisteredFixture(env,companyId);throw error;}
}
export async function disableRegisteredFixture(env:Pick<Env,'DB'>,companyId:string){
 const users='SELECT user_id FROM company_admin WHERE company_id=? UNION SELECT user_id FROM staff WHERE company_id=?';
 await env.DB.batch([
  env.DB.prepare(`UPDATE access_state SET enabled=0 WHERE user_id IN (${users})`).bind(companyId,companyId),
  env.DB.prepare(`DELETE FROM session WHERE userId IN (${users})`).bind(companyId,companyId),
  env.DB.prepare(`UPDATE account SET password=NULL WHERE userId IN (${users})`).bind(companyId,companyId),
 ]);
}
