import { z } from 'zod';
import { mutation, month, ProductError, requireManager } from './product';
import { parseResource, type InputKind, companyPolicy, storedCompanyPolicy, employmentPolicy, staffContract, teamConfig, storedTeamConfig, planning, staffMonth } from './input-contracts';
import { registrationDraft, registrationDraftGuard, type RegistrationDraft } from './input-draft-context';
import {effectivePlanning,loadParticipationRemovals} from './planning-participation';

export type InputDatabase = Pick<D1Database,'prepare'|'batch'>;
export const inputMonth=month.refine(value=>value.startsWith('20'),'UNSUPPORTED_INPUT_PROFILE_MONTH');
export const resourceMutation = mutation.extend({ effectiveFrom:inputMonth, payload:z.unknown() }).strict();
export type ResourceTarget = { company:string; team:string|null; staff:string|null; kind:InputKind; entity:string };
export type VersionRow = { operation_id:string; team_id:string|null; staff_id:string|null; kind:InputKind; entity_id:string; effective_from:string; revision:number; payload:string };
export const isMonthly = (kind:InputKind) => kind === 'planning' || kind === 'staff_month';
export async function resolveVersion(db:InputDatabase, company:string, kind:InputKind, entity:string, targetMonth:string) {
  inputMonth.parse(targetMonth);
  const row=await db.prepare(`SELECT operation_id,team_id,staff_id,kind,entity_id,effective_from,revision,payload FROM work_input_version
    WHERE company_id=? AND kind=? AND entity_id=? AND effective_from ${isMonthly(kind)?'=':'<='} ?
    ORDER BY effective_from DESC,revision DESC LIMIT 1`).bind(company,kind,entity,targetMonth).first<VersionRow>();
  return row&&kind==='planning'?effectivePlanning(row,await loadParticipationRemovals(db,company,entity,targetMonth)):row;
}
export function requiredVersion(row:VersionRow|null) {
  if (!row) throw new ProductError('INPUT_NOT_CONFIGURED',400);
  return row;
}
function interval(start:number,end:number) { if(start>=end)throw new ProductError('EMPTY_OR_REVERSED_INTERVAL',400); }
function rule(value:z.infer<typeof companyPolicy>['rule']) {
  if(value.monthlyMin>value.monthlyMax)throw new ProductError('CONTRADICTORY_RULE',400);
}
function sameMonth(date:string,targetMonth:string) { if(date.slice(0,7)!==targetMonth)throw new ProductError('OUTSIDE_MONTH',400); }
export function unique(values:unknown[],code='DUPLICATE_INPUT') {
  if(new Set(values.map(v=>JSON.stringify(v))).size!==values.length)throw new ProductError(code,400);
}
export type ResourceContext = { policy?:unknown;employment?:unknown;config?:unknown;members?:string[] };
export function validateResourcePayload(t:ResourceTarget,effectiveFrom:string,payload:unknown,context:ResourceContext) {
  if(t.kind==='company_policy'||t.kind==='employment_policy') {
    const p=t.kind==='company_policy'?companyPolicy.parse(payload):employmentPolicy.parse(payload);
    interval(p.contract.start,p.contract.end);rule(p.rule);
  } else if(t.kind==='team_config') {
    const p=teamConfig.parse(payload);
    const policy=storedCompanyPolicy.parse(context.policy);
    const levels=policy.skillLevels.map(l=>l.level);
    unique(p.tasks.map(x=>x.id));unique(p.roles.map(x=>x.id));unique(p.patterns.map(x=>x.id));
    for(const task of p.tasks) {
      if(!levels.includes(task.minimumLevel)||task.capacities.length!==levels.length||task.capacities.some(c=>!levels.includes(c.level)||(task.kind==='dedicated'&&c.capacity!==0)))throw new ProductError('INVALID_TASK_CAPACITY_LEVEL',400);
    }
    for(const pattern of p.patterns) {
      interval(pattern.start,pattern.end);
      if((pattern.breakKind==='fixed')!==!!pattern.fixedBreak)throw new ProductError('FIXED_BREAK_REQUIRED_ONLY_FOR_FIXED',400);
      if(pattern.fixedBreak && !(pattern.start<=pattern.fixedBreak[0]&&pattern.fixedBreak[0]<pattern.fixedBreak[1]&&pattern.fixedBreak[1]<=pattern.end))throw new ProductError('INVALID_FIXED_BREAK',400);
    }
    for(const role of p.roles) {
      unique(role.allowedTasks);
      if(role.allowedTasks.some(id=>!p.tasks.some(task=>task.id===id&&task.kind==='general')))throw new ProductError('INVALID_ROLE_TASK',400);
    }
    unique(p.transitions.map(x=>[x.fromTaskId,x.toTaskId]));
    for(const transition of p.transitions) {
      if(transition.minutes>p.slotMinutes)throw new ProductError('PREPARATION_EXCEEDS_SLOT',400);
      if(transition.fromTaskId===transition.toTaskId||[transition.fromTaskId,transition.toTaskId].some(id=>!p.tasks.some(task=>task.id===id)))throw new ProductError('INVALID_TRANSITION_PAIR',400);
    }
    if(p.rolePolicies.some(x=>x.taskId!==null&&!p.tasks.some(t=>t.id===x.taskId&&t.kind==='general')))throw new ProductError('INVALID_ROLE_POLICY_SCOPE',400);
  } else if(t.kind==='staff_contract') {
    const p=staffContract.parse(payload);interval(p.contract.start,p.contract.end);if(p.rule)rule(p.rule);
    const policy=storedCompanyPolicy.parse(context.policy);
    const employment=employmentPolicy.parse(context.employment);
    const config=storedTeamConfig.parse(context.config);
    interval(Math.max(policy.contract.start,employment.contract.start,p.contract.start),Math.min(policy.contract.end,employment.contract.end,p.contract.end));
    if(!p.contract.weekdays.some(day=>policy.contract.weekdays.includes(day)&&employment.contract.weekdays.includes(day)))throw new ProductError('CONTRADICTORY_CONTRACT',400);
    if(p.skills.some(s=>!policy.skillLevels.some(l=>l.level===s.level)||!config.tasks.some(t=>t.id===s.taskId))||p.roleIds.some(r=>!config.roles.some(role=>role.id===r)))throw new ProductError('UNKNOWN_SKILL_OR_ROLE',400);
  } else if(t.kind==='planning') {
    const p=planning.parse(payload);
    const config=storedTeamConfig.parse(context.config);
    const members=new Set(context.members);
    unique(p.demand.map(d=>[d.date,d.start,d.taskId]));unique(p.events.map(e=>e.id));unique(p.roleRequirements.map(r=>r.id));
    for(const demand of p.demand) {
      sameMonth(demand.date,effectiveFrom);
      if(demand.end-demand.start!==config.slotMinutes||demand.start%config.slotMinutes)throw new ProductError('INVALID_DEMAND_SLOT',400);
      if(demand.direct===null&&demand.calculated===null)throw new ProductError('DEMAND_UNSET',400);
      if(!config.tasks.some(task=>task.id===demand.taskId&&task.kind==='general'))throw new ProductError('INVALID_DEMAND_TASK',400);
    }
    for(const event of p.events) {
      sameMonth(event.date,effectiveFrom);interval(event.start,event.end);
      if(event.staffIds.some(id=>!members.has(id)))throw new ProductError('UNKNOWN_STAFF',400);
    }
    for(const requirement of p.roleRequirements) {
      sameMonth(requirement.date,effectiveFrom);interval(requirement.start,requirement.end);
      if(!config.roles.some(r=>r.id===requirement.roleId)||!config.rolePolicies.some(p=>p.taskId===requirement.taskId))throw new ProductError('UNKNOWN_ROLE_REQUIREMENT_SCOPE',400);
    }
    const ordered=[...p.roleRequirements].sort((a,b)=>JSON.stringify([a.date,a.roleId,a.taskId]).localeCompare(JSON.stringify([b.date,b.roleId,b.taskId]))||a.start-b.start);
    for(let i=1;i<ordered.length;i++) {
      const a=ordered[i-1],b=ordered[i];
      if(a.date===b.date&&a.roleId===b.roleId&&a.taskId===b.taskId&&b.start<a.end)throw new ProductError('OVERLAPPING_ROLE_REQUIREMENT',400);
    }
  } else {
    const p=staffMonth.parse(payload);
    const config=storedTeamConfig.parse(context.config);
    unique(p.preferences.map(p=>[p.date,p.kind]));
    for(const item of [...p.unavailable,...p.preferences]) {
      sameMonth(item.date,effectiveFrom);if('start' in item&&item.start!==undefined)interval(item.start,item.end!);
    }
    for(const preference of p.preferences) {
      if(preference.kind==='pattern'&&!config.patterns.some(p=>p.id===preference.patternId))throw new ProductError('UNKNOWN_PREFERENCE_PATTERN',400);
      if(preference.kind==='window'&&(preference.start===undefined||preference.end===undefined))throw new ProductError('PREFERENCE_WINDOW_REQUIRED',400);
      if((preference.kind==='pattern'&&('start' in preference||'end' in preference))||(preference.kind==='window'&&'patternId' in preference))throw new ProductError('UNEXPECTED_PREFERENCE_FIELDS',400);
      if(['work','off'].includes(preference.kind)&&['start','end','patternId'].some(k=>k in preference))throw new ProductError('UNEXPECTED_PREFERENCE_FIELDS',400);
    }
  }
}

export async function validateResource(db:InputDatabase,t:ResourceTarget,effectiveFrom:string,payload:unknown,draft?:RegistrationDraft) {
  const read=async(kind:InputKind,entity:string)=>JSON.parse(requiredVersion(await resolveVersion(db,t.company,kind,entity,effectiveFrom)).payload);
  const context:ResourceContext={};
  if(['team_config','staff_contract'].includes(t.kind))context.policy=await read('company_policy',t.company);
  if(['staff_contract','planning','staff_month'].includes(t.kind))context.config=await read('team_config',t.team!);
  if(t.kind==='staff_contract')context.employment=await read('employment_policy',staffContract.parse(payload).employmentTypeId);
  if(t.kind==='planning')context.members=(await db.prepare('SELECT id FROM staff WHERE company_id=? AND team_id=?').bind(t.company,t.team).all<{id:string}>()).results.map(s=>s.id);
  validateResourcePayload(t,effectiveFrom,payload,context);
  if(t.kind==='planning'||t.kind==='staff_month') {
    // Validate attendance before registering an event or making a participant
    // unavailable. Load only participants' contracts; unrelated incomplete
    // onboarding does not prevent registering a valid event.
    const {loadSources,compileInput}=await import('./input-snapshots');
    const sources=await loadSources(db,t.company,t.team!,effectiveFrom);
    const old=sources.versions.find(v=>v.kind==='planning'&&v.entity_id===t.team);
    const plan=planning.parse(t.kind==='planning'?payload:old?JSON.parse(old.payload):{demand:[],events:[],roleRequirements:[]});
    const participants=new Set(plan.events.flatMap(e=>e.staffIds));
    if(t.kind==='staff_month'&&!participants.has(t.staff!))return;
    if(!participants.size)return;
    sources.versions=sources.versions.filter(v=>!(v.kind===t.kind&&v.entity_id===t.entity));
    sources.versions.push({operation_id:crypto.randomUUID(),team_id:t.team,staff_id:t.staff,kind:t.kind,entity_id:t.entity,effective_from:effectiveFrom,revision:sources.revision+1,payload:JSON.stringify(payload)});
    sources.staff=sources.staff.filter(s=>participants.has(s.id));
    const fixed=draft?{
      locks:draft.fixed.locks.filter(l=>participants.has(l.staffId)),
      exceptions:draft.fixed.exceptions.filter(e=>participants.has(e.staffId)),
    }:undefined;
    compileInput(t.company,t.team!,effectiveFrom,crypto.randomUUID(),sources,fixed);
  }
}

export async function inputReplay(db:InputDatabase,company:string,id:string,fingerprint:string) {
  const row=await db.prepare('SELECT fingerprint FROM input_operation WHERE company_id=? AND id=?').bind(company,id).first<{fingerprint:string}>();
  if(row&&row.fingerprint!==fingerprint)throw new ProductError('OPERATION_ID_CONFLICT');
  return !!row;
}
export function inputCompletionGuard(db:InputDatabase,t:Omit<ResourceTarget,'kind'> & {kind:InputKind|'snapshot'},user:string,id:string,expected:number,fingerprint:string) {
  // Raise inside the transaction if any common input fact was silently skipped.
  return db.prepare(`SELECT CASE WHEN EXISTS(
        SELECT 1 FROM input_operation o JOIN company c ON c.id=o.company_id
        JOIN product_audit a ON a.company_id=o.company_id AND a.id=o.id
        WHERE o.company_id=? AND o.id=? AND o.actor_id=? AND o.team_id IS ? AND o.staff_id IS ?
          AND o.kind=? AND o.entity_id=? AND o.expected_revision=? AND o.fingerprint=?
          AND c.revision=? AND a.kind='input:'||o.kind AND a.actor_id=o.actor_id AND a.revision=c.revision
          AND ((o.kind='snapshot' AND EXISTS(SELECT 1 FROM input_snapshot s
            WHERE s.company_id=o.company_id AND s.id=o.id AND s.team_id=o.team_id AND s.input_revision=o.expected_revision))
          OR (o.kind!='snapshot' AND EXISTS(SELECT 1 FROM work_input_version v
            WHERE v.company_id=o.company_id AND v.operation_id=o.id AND v.kind=o.kind AND v.entity_id=o.entity_id
              AND v.team_id IS o.team_id AND v.staff_id IS o.staff_id AND v.revision=c.revision)))
      ) THEN 1 ELSE abs(-9223372036854775808) END AS completed`)
        .bind(t.company,id,user,t.team,t.staff,t.kind,t.entity,expected,fingerprint,expected+(t.kind==='snapshot'?0:1));
}
export async function commitInput(db:InputDatabase,t:Omit<ResourceTarget,'kind'> & {kind:InputKind|'snapshot'},user:string,id:string,expected:number,fingerprint:string,statements:D1PreparedStatement[],completion:D1PreparedStatement[] = []) {
  try {
    await db.batch([
      db.prepare('INSERT INTO input_operation(company_id,id,actor_id,team_id,staff_id,kind,entity_id,expected_revision,fingerprint) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(t.company,id,user,t.team,t.staff,t.kind,t.entity,expected,fingerprint),
      ...statements,
      db.prepare('INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,?,?,?)')
        .bind(t.company,id,user,'input:'+t.kind,expected+(t.kind==='snapshot'?0:1),Date.now()),
      ...completion,
      inputCompletionGuard(db,t,user,id,expected,fingerprint),
    ]);
    return false;
  } catch(error) {
    if(await inputReplay(db,t.company,id,fingerprint)) { await requireManager(db,t.company,t.team,user);return true; }
    if(String(error).includes('INPUT_FORBIDDEN'))throw new ProductError('FORBIDDEN',403);
    if(String(error).includes('INPUT_VERSION_CONFLICT'))throw new ProductError('VERSION_CONFLICT');
    if(String(error).includes('INPUT_DRAFT_SOURCE_REQUIRED'))throw new ProductError('DRAFT_SOURCE_REQUIRED');
    if(String(error).includes('INPUT_DRAFT_VERSION_CONFLICT'))throw new ProductError('DRAFT_VERSION_CONFLICT');
    if(String(error).includes('FOREIGN KEY constraint'))throw new ProductError('INVALID_REFERENCE',400);
    if(String(error).includes('UNIQUE constraint'))throw new ProductError('DUPLICATE_RESOURCE');
    throw error;
  }
}
export async function saveInputVersion(db:InputDatabase,t:ResourceTarget,user:string,data:z.infer<typeof resourceMutation>,bucket?:R2Bucket) {
  const input=resourceMutation.parse(data);
  await requireManager(db,t.company,t.team,user);
  z.string().uuid().parse(t.entity);
  const payload=parseResource(t.kind,input.payload);
  const fingerprint=JSON.stringify({target:t,user,...input,payload});
  if(await inputReplay(db,t.company,input.operationId,fingerprint))return {id:input.operationId,revision:input.expectedRevision+1,replayed:true};
  if(t.staff&&!await db.prepare('SELECT 1 FROM staff WHERE company_id=? AND team_id=? AND id=?').bind(t.company,t.team,t.staff).first())throw new ProductError('INVALID_REFERENCE',400);
  const draft=isMonthly(t.kind)?await registrationDraft(db,bucket,t,user,input.effectiveFrom):undefined;
  await validateResource(db,t,input.effectiveFrom,payload,draft);
  const replayed=await commitInput(db,t,user,input.operationId,input.expectedRevision,fingerprint,[
    db.prepare('INSERT INTO work_input_version(company_id,operation_id,team_id,staff_id,kind,entity_id,effective_from,revision,payload) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(t.company,input.operationId,t.team,t.staff,t.kind,t.entity,input.effectiveFrom,input.expectedRevision+1,JSON.stringify(payload)),
    ...(draft?[registrationDraftGuard(db,t,input.operationId,input.effectiveFrom,draft)]:[]),
  ],[
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM work_input_version
      WHERE company_id=? AND operation_id=? AND effective_from=? AND payload=?)
      THEN 1 ELSE abs(-9223372036854775808) END AS payload_saved`)
      .bind(t.company,input.operationId,input.effectiveFrom,JSON.stringify(payload)),
    ...(draft?[db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM input_registration_draft
      WHERE company_id=? AND operation_id=? AND team_id=? AND month=? AND draft_id IS ? AND draft_revision=?)
      THEN 1 ELSE abs(-9223372036854775808) END AS source_saved`)
      .bind(t.company,input.operationId,t.team,input.effectiveFrom,draft.id,draft.revision)]:[]),
  ]);
  return {id:input.operationId,revision:input.expectedRevision+1,replayed};
}
