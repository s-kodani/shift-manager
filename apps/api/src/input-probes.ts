import {settledMaintenanceWork} from './maintenance';
// Dedicated fictitious PoC data. Not imported by the product HTTP router.
import { provisionCompany,createTeam,createStaff,saveCalendarSettings } from './product';
import { type InputDatabase,saveInputVersion,resolveVersion } from './input-versions';
import type { InputKind } from './input-contracts';
import { createInputSnapshot,readInputSnapshot } from './input-snapshots';
import {contractOptions} from './input-catalogs';

export const probeRule={dailyMax:480,weeklyMax:2400,monthlyMin:60,monthlyMax:12000,minDays:1,minOff:4,maxConsecutive:6};
export const probePolicy={rule:probeRule,contract:{weekdays:[0,1,2,3,4,5,6],start:480,end:1200},skillLevels:[{level:0,name:'初級'},{level:1,name:'標準'}],breakRule:{basis:'elapsed',threshold:360,requiredMinutes:60,afterStart:120,beforeEnd:60}};
export const probeEmployment={name:'架空雇用区分',rule:{...probeRule,dailyMax:450},contract:{weekdays:[0,1,2,3,4,5],start:540,end:1080}};
export const probeConfig={slotMinutes:30,priority:'coverage',capacityScale:100,
  patterns:[{id:'day',start:600,end:1020,breakKind:'fixed',fixedBreak:[780,840]}],
  tasks:[{id:'phone',kind:'general',minimumLevel:1,minimumMinutes:10,capacities:[{level:0,capacity:50},{level:1,capacity:100}]},{id:'supervision',kind:'dedicated',minimumLevel:1,minimumMinutes:10,capacities:[{level:0,capacity:0},{level:1,capacity:0}]}],
  roles:[{id:'sv',allowedTasks:['phone']}],
  transitions:[{fromTaskId:'phone',toTaskId:'supervision',minutes:7},{fromTaskId:'supervision',toTaskId:'phone',minutes:7}],
  rolePolicies:[{taskId:null,priority:'first'},{taskId:'phone',priority:'same'}],
};
export async function inputFixture(db:InputDatabase,bucket?:R2Bucket,companyName='架空入力検証企業') {
  const email=`${crypto.randomUUID()}@example.invalid`;
  const company=await provisionCompany(db,{name:companyName,adminName:'架空管理者',adminEmail:email});
  try {
  await db.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(company.userId).run();
  const team=(await createTeam(db,company.companyId,company.userId,{operationId:crypto.randomUUID(),expectedRevision:0,name:'架空電話チーム'})).teamId;
  const staff=await createStaff(db,company.companyId,team,company.userId,{operationId:crypto.randomUUID(),expectedRevision:1,name:'架空入力スタッフ',staffNumber:'0001',email:`${crypto.randomUUID()}@example.invalid`});
  const staffUser=(await db.prepare('SELECT user_id FROM staff WHERE company_id=? AND id=?').bind(company.companyId,staff.staffId).first<string>('user_id'))!;
  await saveCalendarSettings(db,company.companyId,company.userId,{operationId:crypto.randomUUID(),expectedRevision:2,effectiveFrom:'2026-10',settings:{weekStart:0,deadlineDay:20,halfDayDivider:720,roleRounding:'floor'}});
  let revision=3;
  const employment=crypto.randomUUID();
  const profile={employmentTypeId:employment,contract:{weekdays:[1,2,3,4,5],start:600,end:1020},rule:{...probeRule,dailyMax:420,monthlyMin:120},skills:[{taskId:'phone',level:1},{taskId:'supervision',level:1}],roleIds:['sv']};
  const plan={demand:[{date:'2026-10-01',start:600,end:630,taskId:'phone',direct:0,calculated:2},{date:'2026-10-01',start:630,end:660,taskId:'phone',direct:null,calculated:1}],
    events:[{id:'training',date:'2026-10-01',start:660,end:690,kind:'training',staffIds:[staff.staffId]}],
    roleRequirements:[{id:'role',date:'2026-10-01',start:600,end:630,taskId:'phone',roleId:'sv',minimum:1,ratioNumerator:1,ratioDenominator:5}]};
  const save=async(kind:InputKind,payload:unknown,entity?:string,effectiveFrom='2026-10')=>{
    const global=kind==='company_policy'||kind==='employment_policy';
    const personal=kind==='staff_contract'||kind==='staff_month';
    const result=await saveInputVersion(db,{company:company.companyId,team:global?null:team,staff:personal?staff.staffId:null,kind,entity:entity??(global?company.companyId:personal?staff.staffId:team)},company.userId,{operationId:crypto.randomUUID(),expectedRevision:revision,effectiveFrom,payload},bucket);
    revision=result.revision;return result;
  };
  await save('company_policy',probePolicy);
  await save('employment_policy',probeEmployment,employment);
  await save('team_config',probeConfig);
  await save('staff_contract',profile);
  await save('planning',plan);
  await save('staff_month',{unavailable:[],preferences:[{date:'2026-10-01',kind:'work'},{date:'2026-10-01',kind:'pattern',patternId:'day'},{date:'2026-10-01',kind:'window',start:600,end:1020}]});
  return {company,team,staff,staffUser,email,employment,profile,plan,save,revision};
  } catch(error) {
    await db.prepare('UPDATE access_state SET enabled=0 WHERE user_id=? OR user_id IN (SELECT user_id FROM staff WHERE company_id=?)').bind(company.userId,company.companyId).run();
    throw error;
  }
}

export async function runInputProbes(env:Pick<Env,'DB'|'INPUTS'>) {
  const f=await inputFixture(env.DB);const c=f.company.companyId,u=f.company.userId;
  const results:{name:string;passed:boolean}[]=[];
  const record=(name:string,passed:boolean)=>{results.push({name,passed});if(!passed)throw new Error('INPUT_PROBE_FAILED');};
  try {
    const command={operationId:crypto.randomUUID(),expectedRevision:f.revision,month:'2026-10'};
    const outcomes=await settledMaintenanceWork([createInputSnapshot(env.DB,env.INPUTS,c,f.team,u,command),createInputSnapshot(env.DB,env.INPUTS,c,f.team,u,command)]);
    record('same_snapshot_id_has_one_winner',outcomes.filter(r=>r.replayed).length===1&&outcomes[0].snapshot?.object_key===outcomes[1].snapshot?.object_key);
    const snapshot=await readInputSnapshot(env.DB,env.INPUTS,c,f.team,u,command.operationId,true);
    record('all_rules_and_contracts_preserved',snapshot.input.staff[0].rules.length===3&&snapshot.input.staff[0].contract.start===600&&snapshot.input.weekStart===6);
    record('direct_zero_and_company_role_rounding_preserved',snapshot.input.demand[0].direct===0&&snapshot.input.demand[1].direct===null&&snapshot.input.roleRequirements[0].rounding==='floor');
    record('digest_object_identity_matches',snapshot.snapshot.sha256.length===64&&snapshot.input.jobId===command.operationId&&!snapshot.stale);
    await f.save('company_policy',{...probePolicy,rule:{...probeRule,monthlyMin:180}},undefined,'2026-11');
    await f.save('employment_policy',{...probeEmployment,name:'架空将来区分'},f.employment,'2026-12');
    await f.save('employment_policy',{...probeEmployment,name:'架空区分改訂'},f.employment,'2026-10');
    const currentChoices=await contractOptions(env.DB,c,f.team,u,'2026-10');
    const futureChoices=await contractOptions(env.DB,c,f.team,u,'2026-12');
    record('contract_catalog_selects_effective_month_before_revision',currentChoices.employment.length===1&&currentChoices.employment[0].payload.name==='架空区分改訂'&&futureChoices.employment[0].payload.name==='架空将来区分');
    let denied=false;
    try {await contractOptions(env.DB,c,crypto.randomUUID(),u,'2026-10');}catch(error){denied=error instanceof Error&&error.message==='FORBIDDEN';}
    record('contract_catalog_rejects_unknown_team',denied);
    let contradictoryWeekdays=false;
    try {await f.save('staff_contract',{...f.profile,contract:{...f.profile.contract,weekdays:[6]}});}catch(error){contradictoryWeekdays=error instanceof Error&&error.message==='CONTRADICTORY_CONTRACT';}
    record('empty_contract_weekday_intersection_is_refused',contradictoryWeekdays);
    const historical=await readInputSnapshot(env.DB,env.INPUTS,c,f.team,u,command.operationId);
    record('historical_object_is_immutable_and_stale',historical.stale&&historical.snapshot.sha256===snapshot.snapshot.sha256&&historical.input.staff[0].rules[0].monthlyMin===60);
    record('monthly_inputs_do_not_carry_forward',await resolveVersion(env.DB,c,'planning',f.team,'2026-11')===null);
    return {results,snapshot:snapshot.snapshot,input:snapshot.input,registrationStatus:snapshot.registrationStatus,publication:snapshot.publication};
  } finally {
    await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id IN (?,?)').bind(u,f.staffUser).run();
    await env.DB.prepare('DELETE FROM session WHERE userId IN (?,?)').bind(u,f.staffUser).run();
  }
}
