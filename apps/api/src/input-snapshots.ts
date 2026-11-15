import { z } from 'zod';
import { optimizerInputSchema, type OptimizerInput } from '../../../packages/contracts/optimizer-input.generated';
import { calendarSettings, mutation, month, ProductError, requireManager } from './product';
import { companyPolicy,storedCompanyPolicy,employmentPolicy,staffContract,storedTeamConfig,planning,staffMonth } from './input-contracts';
import { type InputDatabase,type VersionRow,requiredVersion,inputReplay,commitInput,validateResourcePayload,inputMonth } from './input-versions';
import { snapshotDraftStale,snapshotDraftSource } from './draft-lineage';
import {historyQuery,type HistorySource} from './work-history';
import {relevantHistory} from './history-contract';
import {loadPublishedFixed,currentPublishedFixed,ensureCurrentFixedSource,type PublishedFixed} from './published-fixed';
import {fixedDraftInput} from './draft-recalculation';
import {effectivePlanning,loadParticipationRemovals,type ParticipationRemoval} from './planning-participation';

export const snapshotCommand=mutation.extend({month:inputMonth}).strict();
export type SnapshotRow={ id:string;team_id:string;month:string;input_revision:number;object_key:string;sha256:string;byte_length:number;lineage:string;created_at:number };
const weekdayToMonday=(day:number)=>(day+6)%7;
type Sources={revision:number;calendar:{operation_id:string;revision:number;payload:string};versions:VersionRow[];staff:{id:string}[];inactiveStaff?:string[];history?:HistorySource[];publication?:{id:string;revision:number;applied_revision:number};published?:OptimizerInput['published'];fixed?:PublishedFixed;participationRemovals?:ParticipationRemoval[]};
export type SourceInventory = Omit<Sources,'calendar'> & {calendar:Sources['calendar']|null};
export function loadSources(db:InputDatabase,company:string,team:string,targetMonth:string):Promise<Sources>;
export function loadSources(db:InputDatabase,company:string,team:string,targetMonth:string,options:{allowIncomplete:true;bucket:R2Bucket}):Promise<SourceInventory>;
export async function loadSources(db:InputDatabase,company:string,team:string,targetMonth:string,options?:{allowIncomplete:true;bucket:R2Bucket}):Promise<SourceInventory> {
  const results=await db.batch([
    db.prepare('SELECT revision FROM company WHERE id=?').bind(company),
    db.prepare(`SELECT operation_id,revision,payload FROM calendar_settings_version WHERE company_id=? AND effective_from<=?
      ORDER BY effective_from DESC,revision DESC LIMIT 1`).bind(company,targetMonth),
    db.prepare(`SELECT operation_id,team_id,staff_id,kind,entity_id,effective_from,revision,payload FROM (
      SELECT *,row_number() OVER (PARTITION BY kind,entity_id ORDER BY effective_from DESC,revision DESC) AS rank
      FROM work_input_version WHERE company_id=? AND (team_id IS NULL OR team_id=?) AND effective_from<=?
    ) WHERE rank=1 AND (kind NOT IN ('planning','staff_month') OR effective_from=?)`).bind(company,team,targetMonth,targetMonth),
    // Hint ordinals must not depend on randomly generated registration UUIDs.
    // Staff numbers are company-unique; BINARY preserves their exact text order.
    // Published staff remain present for reallocation: their attendance and
    // breaks must survive account deactivation/deletion unchanged.
    db.prepare(`SELECT s.id FROM staff s WHERE s.company_id=? AND s.team_id=? AND (s.status='active' OR EXISTS (
      SELECT 1 FROM schedule_publication_head h JOIN schedule_publication_assignment a
        ON a.company_id=h.company_id AND a.publication_id=h.publication_id
      WHERE h.company_id=s.company_id AND h.team_id=s.team_id AND h.month=? AND a.staff_id=s.id
    )) ORDER BY s.staff_number COLLATE BINARY`).bind(company,team,targetMonth),
    historyQuery(db,company,team,targetMonth),
    db.prepare('SELECT h.publication_id AS id,h.revision,p.applied_revision FROM schedule_publication_head h JOIN schedule_publication_version p ON p.company_id=h.company_id AND p.id=h.publication_id JOIN schedule_publication_commit c ON c.company_id=p.company_id AND c.publication_id=p.id WHERE h.company_id=? AND h.team_id=? AND h.month=?').bind(company,team,targetMonth),
    db.prepare('SELECT a.staff_id AS staffId,a.date,a.shift FROM schedule_publication_head h JOIN schedule_publication_commit c ON c.company_id=h.company_id AND c.publication_id=h.publication_id JOIN schedule_publication_assignment a ON a.company_id=h.company_id AND a.publication_id=h.publication_id WHERE h.company_id=? AND h.team_id=? AND h.month=? ORDER BY a.staff_id,a.date').bind(company,team,targetMonth),
    db.prepare("SELECT id FROM staff WHERE company_id=? AND team_id=? AND status!='active'").bind(company,team),
  ]);
  const revision=z.object({revision:z.number().int().nonnegative()}).parse(results[0].results[0]).revision;
  if(!results[1].results.length&&!options?.allowIncomplete)throw new ProductError('CALENDAR_NOT_CONFIGURED',400);
  const calendar=results[1].results.length?z.object({operation_id:z.string(),revision:z.number().int(),payload:z.string()}).parse(results[1].results[0]):null;
  const version=z.object({operation_id:z.string(),team_id:z.string().nullable(),staff_id:z.string().nullable(),kind:z.enum(['company_policy','employment_policy','staff_contract','team_config','planning','staff_month']),entity_id:z.string(),effective_from:month,revision:z.number().int(),payload:z.string()});
  const publication=results[5].results.length?z.object({id:z.string().uuid(),revision:z.number().int().positive(),applied_revision:z.number().int().positive()}).parse(results[5].results[0]):undefined;
  const fixed=publication?await loadPublishedFixed(db,company,publication.id,options?{bucket:options.bucket,team}:undefined):undefined;
  if(fixed&&fixed.inputRevision!==revision)throw new ProductError('VERSION_CONFLICT');
  const participationRemovals=await loadParticipationRemovals(db,company,team,targetMonth);
  if(await db.prepare('SELECT revision FROM company WHERE id=?').bind(company).first<number>('revision')!==revision)throw new ProductError('VERSION_CONFLICT');
  return {revision,calendar,participationRemovals,inactiveStaff:z.array(z.object({id:z.string()})).parse(results[7].results).map(s=>s.id),versions:z.array(version).parse(results[2].results).map(row=>effectivePlanning(row,participationRemovals)),staff:z.array(z.object({id:z.string()})).parse(results[3].results),history:results[4].results as HistorySource[],publication,fixed,published:optimizerInputSchema.shape.published.parse(results[6].results.map(r=>(()=>{const row=z.object({staffId:z.string(),date:z.string(),shift:z.string()}).parse(r);return {...row,shift:JSON.parse(row.shift)};})()))};
}
export function compileInput(company:string,team:string,targetMonth:string,id:string,sources:Sources,overrides?:Pick<OptimizerInput,'locks'|'exceptions'>,options:{registrationValidation?:boolean;fixedRevision?:number}={}) {
  const lineage:{kind:string;entity:string;version:string;effectiveFrom?:string;revision:number}[]=[{kind:'calendar',entity:company,version:sources.calendar.operation_id,revision:sources.calendar.revision}];
  const selected=new Map(sources.versions.map(v=>[v.kind+':'+v.entity_id,v]));
  const read=(kind:VersionRow['kind'],entity:string,required=true)=>{
    const row=selected.get(kind+':'+entity)??null;
    if(!row&&required)requiredVersion(row);
    if(row)lineage.push({kind,entity,version:row.operation_id,effectiveFrom:row.effective_from,revision:row.revision});
    return row?JSON.parse(row.payload):null;
  };
  const calendar=calendarSettings.parse(JSON.parse(sources.calendar.payload));
  const storedPolicy=storedCompanyPolicy.parse(read('company_policy',company));
  if(!storedPolicy.breakRule)throw new ProductError('COMPANY_BREAK_RULE_NOT_CONFIGURED',400);
  const policy=companyPolicy.parse(storedPolicy);
  const policyVersion=selected.get('company_policy:'+company)!;
  lineage.push({kind:'company_break_rule',entity:company,version:policyVersion.operation_id,effectiveFrom:policyVersion.effective_from,revision:policyVersion.revision});
  const config=storedTeamConfig.parse(read('team_config',team));
  const storedPlan=planning.parse(read('planning',team));
  const members=new Set(sources.staff.map(s=>s.id));
  const excluded=new Set((sources.inactiveStaff??[]).filter(id=>!members.has(id)));
  // Retain original planning versions; only omit inactive participants from
  // a new calculation's effective events.
  const plan={...storedPlan,events:storedPlan.events.map(event=>({...event,staffIds:event.staffIds.filter(id=>!excluded.has(id))}))};
  for(const r of sources.participationRemovals??[])if(r.planningId===selected.get('planning:'+team)?.operation_id)lineage.push({kind:'planning_participation_removal',entity:r.eventId+':'+r.staffId,version:r.operationId,revision:r.revision});
  const target={company,team:null,staff:null,kind:'company_policy' as const,entity:company};
  validateResourcePayload(target,targetMonth,policy,{});
  validateResourcePayload({...target,team,kind:'team_config',entity:team},targetMonth,config,{policy});
  validateResourcePayload({...target,team,kind:'planning',entity:team},targetMonth,plan,{config,members:sources.staff.map(s=>s.id)});
  if(!sources.staff.length)throw new ProductError('NO_ACTIVE_STAFF',400);
  const data:OptimizerInput={
    schemaVersion:'multi-task-v1',tenantId:company,teamId:team,month:targetMonth,
    inputVersion:sources.revision,settingsVersion:sources.calendar.revision,jobId:id,attempt:1,mode:sources.publication?'reallocation':'draft',
    slotMinutes:config.slotMinutes,priority:config.priority,weekStart:weekdayToMonday(calendar.weekStart),capacityScale:config.capacityScale,
    breakRule:policy.breakRule,patterns:config.patterns,roles:config.roles,transitions:config.transitions,
    tasks:config.tasks.map(({capacities:_,...task})=>task),demand:plan.demand,events:plan.events,
    roleRequirements:plan.roleRequirements.map(requirement=>{
      const rolePolicy=config.rolePolicies.find(p=>p.taskId===requirement.taskId);
      if(!rolePolicy)throw new ProductError('ROLE_POLICY_NOT_CONFIGURED',400);
      return {...requirement,rounding:calendar.roleRounding,priority:rolePolicy.priority};
    }),
    staff:sources.staff.map(person=>{
      const profile=staffContract.parse(read('staff_contract',person.id));
      const employment=employmentPolicy.parse(read('employment_policy',profile.employmentTypeId));
      const monthly=staffMonth.parse(read('staff_month',person.id,false)??{unavailable:[],preferences:[]});
      validateResourcePayload({...target,kind:'employment_policy',entity:profile.employmentTypeId},targetMonth,employment,{});
      validateResourcePayload({...target,team,staff:person.id,kind:'staff_contract',entity:person.id},targetMonth,profile,{policy,employment,config});
      validateResourcePayload({...target,team,staff:person.id,kind:'staff_month',entity:person.id},targetMonth,monthly,{config});
      const contracts=[policy.contract,employment.contract,profile.contract];
      const contract={weekdays:contracts[0].weekdays.filter(day=>contracts.every(c=>c.weekdays.includes(day))).map(weekdayToMonday),start:Math.max(...contracts.map(c=>c.start)),end:Math.min(...contracts.map(c=>c.end))};
      if(contract.start>=contract.end)throw new ProductError('CONTRADICTORY_CONTRACT',400);
      const ruleOf=(kind:string,entity:string,rule:z.infer<typeof companyPolicy>['rule'])=>({id:`${kind}:${selected.get(kind+':'+entity)!.operation_id}`,...rule});
      const rules=[ruleOf('company_policy',company,policy.rule),ruleOf('employment_policy',profile.employmentTypeId,employment.rule),...(profile.rule?[ruleOf('staff_contract',person.id,profile.rule)]:[])];
      const dayCount=new Date(Number(targetMonth.slice(0,4)),Number(targetMonth.slice(5)),0).getDate();
      if(Math.max(...rules.map(r=>r.monthlyMin))>Math.min(...rules.map(r=>r.monthlyMax))||Math.max(...rules.map(r=>r.minDays))+Math.max(...rules.map(r=>r.minOff))>dayCount)throw new ProductError('CONTRADICTORY_RULE',400);
      return {id:person.id,contract,rules,...monthly,roleIds:profile.roleIds,skills:profile.skills.map(skill=>{
        const task=config.tasks.find(t=>t.id===skill.taskId);
        const coefficient=task?.capacities.find(c=>c.level===skill.level);
        if(!coefficient||!policy.skillLevels.some(l=>l.level===skill.level))throw new ProductError('CAPACITY_NOT_CONFIGURED',400);
        return {...skill,capacity:coefficient.capacity};
      })};
    }),
    // Only explicitly confirmed, versioned history. Missing days stay missing.
    history:[],locks:overrides?.locks??[],exceptions:overrides?.exceptions??[],published:[],
  };
  if(sources.publication) {
    const byKey=new Map((sources.published??[]).map(p=>[p.staffId+':'+p.date,p]));
    const days=new Date(Date.UTC(Number(targetMonth.slice(0,4)),Number(targetMonth.slice(5)),0)).getUTCDate();
    data.published=data.staff.flatMap(s=>Array.from({length:days},(_,i)=>{const date=targetMonth+'-'+String(i+1).padStart(2,'0');return byKey.get(s.id+':'+date)??{staffId:s.id,date,shift:null};}));
    lineage.push({kind:'published_schedule',entity:team,version:sources.publication.id,revision:sources.publication.revision});
    if(!sources.fixed)throw new ProductError('PUBLISHED_FIXED_SOURCE_REQUIRED');
    const members=new Set(data.staff.map(s=>s.id));
    const fixed={...sources.fixed,locks:sources.fixed.locks.filter(l=>members.has(l.staffId)),originalLocks:sources.fixed.originalLocks.filter(l=>members.has(l.staffId)),exceptions:sources.fixed.exceptions.filter(e=>members.has(e.staffId))};
    const automatic=fixedDraftInput({assignments:data.published.map(a=>({...a,blocks:[],roleIntervals:[]})),locks:fixed.locks,exceptions:fixed.exceptions});
    const current=currentPublishedFixed(fixed,overrides??automatic,options.fixedRevision??0);
    data.locks=current.locks;data.exceptions=current.exceptions;
    for(const release of fixed.releases)lineage.push({kind:'published_fixed_release',entity:release.id,version:release.id,revision:release.appliedRevision});
  }
  const history=relevantHistory(data,sources.history??[]);
  data.history=history.map(({staffId,date,workedMinutes})=>({staffId,date,workedMinutes}));
  for(const row of history as HistorySource[])lineage.push({kind:row.source==='published'?'published_history':'work_history',entity:row.staffId+':'+row.date,version:row.operationId,revision:row.revision});
  optimizerInputSchema.parse(data);
  if(options.registrationValidation!==false)validateCompiledInput(data);
  return {input:data,lineage:Array.from(new Map(lineage.map(v=>[v.kind+':'+v.entity,v])).values())};
}

// Registration checks independent of the Python solver. They do not certify an
// assignment, feasibility, complete history, or fitness for publication.
export function validateCompiledInput(data:OptimizerInput,options:{fixedDays?:boolean}={}) {
  const patterns=new Map(data.patterns.map(p=>[p.id,p]));
  const tasks=new Map(data.tasks.map(t=>[t.id,t]));
  const roles=new Set(data.roles.map(r=>r.id));
  if(data.mode==='reallocation'&&data.published.some(p=>p.shift&&!patterns.has(p.shift.patternId)))throw new ProductError('PUBLISHED_PATTERN_MISSING',400);
  if(data.mode==='reallocation'&&data.published.some(({shift})=>{
    if(!shift)return false;
    const pattern=patterns.get(shift.patternId)!;
    return pattern.start!==shift.start||pattern.end!==shift.end||pattern.breakKind!==shift.breakKind
      ||(pattern.breakKind==='fixed'&&JSON.stringify(pattern.fixedBreak)!==JSON.stringify(shift.break));
  }))throw new ProductError('PUBLISHED_PATTERN_CONFLICT',400);
  const staff=new Map(data.staff.map(s=>[s.id,s]));
  if(data.staff.some(s=>s.roleIds.some(r=>!roles.has(r))||s.skills.some(skill=>!tasks.has(skill.taskId))))throw new ProductError('UNKNOWN_SKILL_OR_ROLE',400);
  if(data.roleRequirements.some(r=>(r.taskId!==null&&tasks.get(r.taskId)?.kind!=='general')||!roles.has(r.roleId)))throw new ProductError('UNKNOWN_ROLE_REQUIREMENT_SCOPE',400);
  for(const person of data.staff) {
    for(const preference of person.preferences)if(preference.kind==='pattern'&&!patterns.has(preference.patternId!))throw new ProductError('UNKNOWN_PREFERENCE_PATTERN',400);
    const events=data.events.filter(e=>e.staffIds.includes(person.id));
    const days=new Set([...events.map(e=>e.date),...(options.fixedDays?[
      ...data.locks.filter(l=>l.staffId===person.id&&l.shift!==null).map(l=>l.date),
      ...data.published.filter(p=>p.staffId===person.id&&p.shift!==null&&p.shift.cancelled.reduce((n,c)=>n+c[1]-c[0],0)<p.shift.end-p.shift.start).map(p=>p.date),
    ]:[])]);
    for(const day of days) {
      const daily=events.filter(e=>e.date===day).sort((a,b)=>a.start-b.start);
      if(daily.some((event,i)=>i>0&&event.start<daily[i-1].end))throw new ProductError('OVERLAPPING_EVENT',400);
      const weekday=weekdayToMonday(new Date(day+'T00:00:00Z').getUTCDay());
      const published=data.mode==='reallocation'?data.published.find(p=>p.staffId===person.id&&p.date===day):undefined;
      const locks=data.locks.filter(l=>l.staffId===person.id&&l.date===day);
      const possible=data.patterns.some(pattern=>{
        if(data.mode==='reallocation'&&(!published?.shift||published.shift.patternId!==pattern.id||published.shift.start!==pattern.start||published.shift.end!==pattern.end||published.shift.breakKind!==pattern.breakKind||published.shift.cancelled.some(c=>daily.some(e=>e.start<c[1]&&c[0]<e.end))))return false;
        if(!person.contract.weekdays.includes(weekday)||pattern.start<person.contract.start||pattern.end>person.contract.end||daily.some(e=>e.start<pattern.start||e.end>pattern.end))return false;
        if(locks.some(l=>!l.shift||(l.parts.includes('pattern')&&l.shift.patternId!==pattern.id)
          ||(l.parts.includes('time')&&(l.shift.start!==pattern.start||l.shift.end!==pattern.end))
          ||(l.parts.includes('break')&&l.shift.breakKind!==pattern.breakKind)))return false;
        const permitted=data.exceptions.filter(e=>e.staffId===person.id&&e.date===day&&e.lockId!==null).filter(e=>{
          const lock=data.locks.find(l=>l.id===e.lockId);
          return lock?.shift&&['pattern','time','break'].every(p=>lock.parts.includes(p as 'pattern'|'time'|'break'))&&lock.shift.patternId===pattern.id&&lock.shift.start===pattern.start&&lock.shift.end===pattern.end;
        });
        if(person.unavailable.some(u=>u.date===day&&Array.from({length:Math.max(0,Math.min(u.end,pattern.end)-Math.max(u.start,pattern.start))},(_,i)=>Math.max(u.start,pattern.start)+i).some(m=>!published?.shift?.cancelled.some(c=>c[0]<=m&&m<c[1])&&!permitted.some(e=>e.start<=m&&m<e.end))))return false;
        const rests=published?.shift?[published.shift.break]:pattern.breakKind==='fixed'?[pattern.fixedBreak!]:[null,...Array.from({length:48},(_,i)=>[i*30,i*30+data.breakRule.requiredMinutes])];
        return rests.some(rest=>{
          if(locks.some(l=>l.parts.includes('break')&&JSON.stringify(l.shift!.break)!==JSON.stringify(rest)))return false;
          const length=rest?rest[1]-rest[0]:0;
          const worked=pattern.end-pattern.start-length;
          const needed=(data.breakRule.basis==='worked'?worked:pattern.end-pattern.start)>data.breakRule.threshold?data.breakRule.requiredMinutes:0;
          return length>=needed&&(pattern.breakKind==='fixed'||length===needed)&&person.rules.every(rule=>worked<=rule.dailyMax)
            &&(!rest||(rest[0]>=pattern.start+data.breakRule.afterStart&&rest[1]<=pattern.end-data.breakRule.beforeEnd&&rest[0]<rest[1]&&!daily.some(e=>e.start<rest[1]&&rest[0]<e.end)));
        });
      });
      if(!possible)throw new ProductError('EVENT_ATTENDANCE_CONFLICT',400);
    }
  }
  if(data.events.some(e=>e.staffIds.some(id=>!staff.has(id))))throw new ProductError('UNKNOWN_STAFF',400);
}
export async function sha256(value:Uint8Array) {
  const digest=await crypto.subtle.digest('SHA-256',value);
  return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}
export async function snapshotRow(db:InputDatabase,company:string,id:string) {
  return db.prepare('SELECT id,team_id,month,input_revision,object_key,sha256,byte_length,lineage,created_at FROM input_snapshot WHERE company_id=? AND id=?').bind(company,id).first<SnapshotRow>();
}
export async function createInputSnapshot(db:InputDatabase,bucket:R2Bucket,company:string,team:string,user:string,data:z.infer<typeof snapshotCommand>) {
  const c=snapshotCommand.parse(data);await requireManager(db,company,team,user);
  const fingerprint=JSON.stringify({company,team,user,...c});
  if(await inputReplay(db,company,c.operationId,fingerprint)) {
    const snapshot=await snapshotRow(db,company,c.operationId);
    if(!snapshot)throw new Error('SNAPSHOT_MANIFEST_MISSING');
    return {snapshot,replayed:true};
  }
  await ensureCurrentFixedSource({DB:db,INPUTS:bucket},company,team,c.month);
  const sources=await loadSources(db,company,team,c.month);
  if(sources.revision!==c.expectedRevision)throw new ProductError('VERSION_CONFLICT');
  if(await db.prepare('SELECT draft_id FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?').bind(company,team,c.month).first('draft_id'))throw new ProductError('DRAFT_SOURCE_REQUIRED');
  const compiled=compileInput(company,team,c.month,c.operationId,sources);
  return persistCompiledSnapshot(db,bucket,company,team,user,c,fingerprint,compiled);
}
export async function persistCompiledSnapshot(db:InputDatabase,bucket:R2Bucket,company:string,team:string,user:string,c:z.infer<typeof snapshotCommand>,fingerprint:string,compiled:ReturnType<typeof compileInput>,extra:D1PreparedStatement[]=[]) {
  const bytes=new TextEncoder().encode(JSON.stringify(compiled.input));
  if(bytes.byteLength>4_000_000)throw new ProductError('INPUT_TOO_LARGE',400);
  const digest=await sha256(bytes);
  // A unique upload per attempt prevents a concurrent retry from overwriting or
  // deleting the winning object's bytes. Object names contain no email/name.
  const key=`companies/${company}/teams/${team}/snapshots/${c.operationId}/${crypto.randomUUID()}.json`;
  const stored=await bucket.put(key,bytes,{sha256:digest,onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(!stored)throw new Error('SNAPSHOT_OBJECT_NOT_WRITTEN');
  const replayed=await commitInput(db,{company,team,staff:null,kind:'snapshot',entity:c.operationId},user,c.operationId,c.expectedRevision,fingerprint,[
    db.prepare('INSERT INTO input_snapshot(company_id,id,team_id,month,input_revision,object_key,sha256,byte_length,lineage,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(company,c.operationId,team,c.month,c.expectedRevision,key,digest,bytes.byteLength,JSON.stringify(compiled.lineage),Date.now()),
    ...extra,
  ],[
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM input_snapshot s
      WHERE s.company_id=? AND s.id=? AND s.team_id=? AND s.month=? AND s.input_revision=?
        AND s.object_key=? AND s.sha256=? AND s.byte_length=? AND s.lineage=?
        AND NOT EXISTS(SELECT 1 FROM json_each(s.lineage) e
          WHERE json_extract(e.value,'$.kind')='manual_draft' AND NOT EXISTS(
            SELECT 1 FROM input_snapshot_draft d WHERE d.company_id=s.company_id AND d.snapshot_id=s.id
              AND d.draft_id=json_extract(e.value,'$.version') AND d.draft_revision=json_extract(e.value,'$.revision')
          ))
      ) THEN 1 ELSE abs(-9223372036854775808) END AS manifest_saved`)
      .bind(company,c.operationId,team,c.month,c.expectedRevision,key,digest,bytes.byteLength,JSON.stringify(compiled.lineage)),
  ]);
  const snapshot=await snapshotRow(db,company,c.operationId);
  if(!snapshot)throw new Error('SNAPSHOT_MANIFEST_MISSING');
  // Keep losing uploads immutable too: a retired request has no delete right.
  // On any uncertain D1 failure keep the uploaded object. Later GC must prove
  // it is unreferenced after a grace period; absence in one read is not proof.
  return {snapshot,replayed};
}
export async function readInputSnapshot(db:InputDatabase,bucket:R2Bucket,company:string,team:string,user:string,id:string,requireCurrent=false,manualRecheck=false) {
  await requireManager(db,company,team,user);
  const row=await snapshotRow(db,company,id);
  if(!row||row.team_id!==team)throw new ProductError('NOT_FOUND',404);
  const current=await db.prepare('SELECT revision FROM company WHERE id=?').bind(company).first<number>('revision');
  const lineage=z.array(z.object({kind:z.string(),entity:z.string(),version:z.string(),revision:z.number().int()})).parse(JSON.parse(row.lineage));
  const policyVersion=lineage.find(v=>v.kind==='company_policy'&&v.entity===company);
  const companyBreakRule=lineage.some(v=>v.kind==='company_break_rule'&&v.entity===company&&v.version===policyVersion?.version&&v.revision===policyVersion?.revision);
  const draftStale=await snapshotDraftStale(db,company,id);
  const stale=current!==row.input_revision||!companyBreakRule||draftStale;
  if(current!==row.input_revision&&requireCurrent)throw new ProductError('VERSION_CONFLICT');
  // Manual candidates replace locks/exceptions and independently revalidate all
  // assignments. Their own expected head is guarded on save; input stays current.
  if(draftStale&&requireCurrent&&!manualRecheck)throw new ProductError('DRAFT_VERSION_CONFLICT');
  if(!companyBreakRule&&requireCurrent)throw new ProductError('SNAPSHOT_REBUILD_REQUIRED',400);
  const object=await bucket.get(row.object_key);
  if(!object||object.size!==row.byte_length||object.size>4_000_000)throw new Error('SNAPSHOT_OBJECT_MISSING_OR_SIZE_MISMATCH');
  const reader=object.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  while(true) { const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>row.byte_length){await reader.cancel();throw new Error('SNAPSHOT_OBJECT_TOO_LARGE');}chunks.push(value); }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  if(size!==row.byte_length||await sha256(bytes)!==row.sha256)throw new Error('SNAPSHOT_DIGEST_MISMATCH');
  const input=optimizerInputSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if(input.tenantId!==company||input.teamId!==team||input.month!==row.month||input.inputVersion!==row.input_revision||input.jobId!==id)throw new Error('SNAPSHOT_IDENTITY_MISMATCH');
  return {snapshot:row,input,stale,draftSource:await snapshotDraftSource(db,company,id),registrationStatus:'STRUCTURALLY_VALID' as const,publication:'NOT_EVALUATED' as const};
}
