import { z } from 'zod';
import { ProductError, requireManager, resolveCalendarSettings } from './product';
import { inputMonth, inputReplay, inputCompletionGuard, resolveVersion, requiredVersion, validateResourcePayload, type InputDatabase, type ResourceTarget } from './input-versions';
import { planning, storedTeamConfig } from './input-contracts';
import { ownSubmissionStaff } from './staff-submission-access';
import { staffSubmission, submissionWindowCommand, submissionContext } from './staff-submission-contract';
import { submissionDeadline } from './submission-deadline';
import { registrationDraft, registrationDraftGuard } from './input-draft-context';
import { loadSources, compileInput, validateCompiledInput } from './input-snapshots';

async function calendar(db:InputDatabase,company:string,month:string) {
  const selected=await resolveCalendarSettings(db,company,month);
  if(!selected)throw new ProductError('CALENDAR_NOT_CONFIGURED',400);
  return {id:selected.id,deadline:submissionDeadline(month,selected.settings.deadlineDay)};
}
async function window(db:InputDatabase,company:string,team:string,month:string) {
  return db.prepare(`SELECT id,expected_revision+1 AS revision,closes_at AS closesAt FROM staff_submission_window
    WHERE company_id=? AND team_id=? AND month=? ORDER BY expected_revision DESC LIMIT 1`)
    .bind(company,team,month).first<{id:string;revision:number;closesAt:number|null}>();
}
export async function readSubmissionWindow(db:InputDatabase,company:string,team:string,user:string,month:string) {
  inputMonth.parse(month);await requireManager(db,company,team,user);
  const selected=await calendar(db,company,month),w=await window(db,company,team,month);
  await requireManager(db,company,team,user);
  return {month,serverTime:Date.now(),deadline:selected.deadline,window:w};
}
function mapError(error:unknown):never {
  const message=String(error);
  if(message.includes('INPUT_FORBIDDEN'))throw new ProductError('FORBIDDEN',403);
  for(const code of ['SUBMISSION_CLOSED','SUBMISSION_CALENDAR_CONFLICT','SUBMISSION_WINDOW_CONFLICT','SUBMISSION_WINDOW_EXPIRED','INPUT_DRAFT_VERSION_CONFLICT'])
    if(message.includes(code))throw new ProductError(code==='INPUT_DRAFT_VERSION_CONFLICT'?'DRAFT_VERSION_CONFLICT':code);
  if(message.includes('INPUT_VERSION_CONFLICT'))throw new ProductError('VERSION_CONFLICT');
  if(message.includes('UNIQUE constraint'))throw new ProductError('OPERATION_ID_CONFLICT');
  throw error;
}
export async function setSubmissionWindow(db:InputDatabase,company:string,team:string,user:string,month:string,data:z.infer<typeof submissionWindowCommand>) {
  inputMonth.parse(month);const c=submissionWindowCommand.parse(data);
  await requireManager(db,company,team,user);
  const fingerprint=JSON.stringify({company,team,user,month,input:c});
  const replay=async()=>{
    const previous=await db.prepare('SELECT fingerprint FROM staff_submission_window WHERE company_id=? AND id=?').bind(company,c.operationId).first<string>('fingerprint');
    if(previous&&previous!==fingerprint)throw new ProductError('OPERATION_ID_CONFLICT');
    if(previous)await requireManager(db,company,team,user);
    return !!previous;
  };
  const result=(replayed:boolean)=>({id:c.operationId,revision:c.expectedRevision+1,replayed});
  if(await replay())return result(true);
  await calendar(db,company,month);
  if(c.closesAt!==null&&c.closesAt<=Date.now())throw new ProductError('SUBMISSION_WINDOW_EXPIRED');
  try {
    await db.batch([
      db.prepare('INSERT INTO staff_submission_window(company_id,id,team_id,month,actor_id,expected_revision,closes_at,fingerprint,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(company,c.operationId,team,month,user,c.expectedRevision,c.closesAt,fingerprint,Date.now()),
      db.prepare(`INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at)
        SELECT ?,?,?,'staff_submission_window',revision,? FROM company WHERE id=?`).bind(company,c.operationId,user,Date.now(),company),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM staff_submission_window w
        JOIN product_audit a ON a.company_id=w.company_id AND a.id=w.id
        JOIN company c ON c.id=w.company_id
        WHERE w.company_id=? AND w.id=? AND w.team_id=? AND w.month=? AND w.actor_id=?
          AND w.expected_revision=? AND w.closes_at IS ? AND w.fingerprint=?
          AND a.kind='staff_submission_window' AND a.actor_id=w.actor_id AND a.revision=c.revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS window_saved`)
        .bind(company,c.operationId,team,month,user,c.expectedRevision,c.closesAt,fingerprint),
    ]);
    return result(false);
  }catch(error){if(await replay())return result(true);mapError(error);}
}
export async function readStaffSubmission(db:InputDatabase,company:string,team:string,user:string,month:string) {
  inputMonth.parse(month);const staff=await ownSubmissionStaff(db,company,team,user);
  // Optimistic fence: do not return a mixed input/configuration revision.
  const revision=await db.prepare('SELECT revision FROM company WHERE id=?').bind(company).first<number>('revision');
  const selected=await calendar(db,company,month),w=await window(db,company,team,month);
  const config=storedTeamConfig.parse(JSON.parse(requiredVersion(await resolveVersion(db,company,'team_config',team,month)).payload));
  const v=await resolveVersion(db,company,'staff_month',staff,month);
  if(await db.prepare('SELECT revision FROM company WHERE id=?').bind(company).first<number>('revision')!==revision)throw new ProductError('VERSION_CONFLICT');
  if(await ownSubmissionStaff(db,company,team,user)!==staff)throw new ProductError('FORBIDDEN',403);
  const serverTime=Date.now();
  return submissionContext.parse({month,revision,staffId:staff,calendarId:selected.id,deadline:selected.deadline,window:w,serverTime,
    accepting:serverTime<selected.deadline.closesAt||(w?.closesAt!==null&&serverTime<(w?.closesAt??0)),
    version:v?{id:v.operation_id,revision:v.revision,payload:JSON.parse(v.payload)}:null,
    patterns:config.patterns.map(({id,start,end})=>({id,start,end}))});
}
export async function saveStaffSubmission(db:InputDatabase,bucket:R2Bucket,company:string,team:string,user:string,month:string,data:z.infer<typeof staffSubmission>) {
  inputMonth.parse(month);const c=staffSubmission.parse(data),staff=await ownSubmissionStaff(db,company,team,user);
  const target:ResourceTarget={company,team,staff,kind:'staff_month',entity:staff};
  const fingerprint=JSON.stringify({target,user,month,input:c});
  const result=(replayed:boolean)=>({id:c.operationId,revision:c.expectedRevision+1,replayed});
  // A retry acknowledges the original save, even after the window closes.
  if(await inputReplay(db,company,c.operationId,fingerprint)){await ownSubmissionStaff(db,company,team,user);return result(true);}
  const selected=await calendar(db,company,month),w=await window(db,company,team,month);
  if(Date.now()>=selected.deadline.closesAt&&Date.now()>=(w?.closesAt??0))throw new ProductError('SUBMISSION_CLOSED');
  const draft=await registrationDraft(db,bucket,target,user,month,true);
  const sources=await loadSources(db,company,team,month);
  if(sources.revision!==c.expectedRevision)throw new ProductError('VERSION_CONFLICT');
  const config=storedTeamConfig.parse(JSON.parse(requiredVersion(await resolveVersion(db,company,'team_config',team,month)).payload));
  validateResourcePayload(target,month,c.payload,{config});
  // Validate this person with company/employment/personal rules and all their
  // events. Other staff's incomplete onboarding cannot block self submission.
  const planVersion=sources.versions.find(v=>v.kind==='planning'&&v.entity_id===team);
  const plan=planning.parse(planVersion?JSON.parse(planVersion.payload):{demand:[],events:[],roleRequirements:[]});
  sources.staff=sources.staff.filter(s=>s.id===staff);
  sources.versions=sources.versions.filter(v=>!(v.kind==='staff_month'&&v.entity_id===staff)&&!(v.kind==='planning'&&v.entity_id===team));
  sources.versions.push({operation_id:c.operationId,team_id:team,staff_id:staff,kind:'staff_month',entity_id:staff,effective_from:month,revision:c.expectedRevision+1,payload:JSON.stringify(c.payload)},
    {operation_id:c.operationId,team_id:team,staff_id:null,kind:'planning',entity_id:team,effective_from:month,revision:c.expectedRevision+1,
      payload:JSON.stringify({demand:[],roleRequirements:[],events:plan.events.filter(e=>e.staffIds.includes(staff)).map(e=>({...e,staffIds:[staff]}))})});
  const fixed={locks:draft.fixed.locks.filter(l=>l.staffId===staff),exceptions:draft.fixed.exceptions.filter(e=>e.staffId===staff)};
  const compiled=compileInput(company,team,month,c.operationId,sources,fixed,{fixedRevision:sources.revision});
  validateCompiledInput(compiled.input,{fixedDays:true});
  try {
    await db.batch([
      db.prepare('INSERT INTO input_operation(company_id,id,actor_id,team_id,staff_id,kind,entity_id,expected_revision,fingerprint,submission_month,submission_calendar_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .bind(company,c.operationId,user,team,staff,'staff_month',staff,c.expectedRevision,fingerprint,month,selected.id),
      db.prepare('INSERT INTO work_input_version(company_id,operation_id,team_id,staff_id,kind,entity_id,effective_from,revision,payload) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(company,c.operationId,team,staff,'staff_month',staff,month,c.expectedRevision+1,JSON.stringify(c.payload)),
      registrationDraftGuard(db,target,c.operationId,month,draft),
      db.prepare('INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,?,?,?)')
        .bind(company,c.operationId,user,'input:staff_month',c.expectedRevision+1,Date.now()),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM work_input_version v
        JOIN input_registration_draft d ON d.company_id=v.company_id AND d.operation_id=v.operation_id
        JOIN input_operation o ON o.company_id=v.company_id AND o.id=v.operation_id
        WHERE v.company_id=? AND v.operation_id=? AND v.effective_from=? AND v.payload=?
          AND d.team_id=? AND d.month=? AND d.draft_id IS ? AND d.draft_revision=?
          AND o.submission_month=? AND o.submission_calendar_id=?
      ) THEN 1 ELSE abs(-9223372036854775808) END AS submission_saved`)
        .bind(company,c.operationId,month,JSON.stringify(c.payload),team,month,draft.id,draft.revision,month,selected.id),
      inputCompletionGuard(db,target,user,c.operationId,c.expectedRevision,fingerprint),
    ]);
    return result(false);
  }catch(error){
    if(await inputReplay(db,company,c.operationId,fingerprint)){await ownSubmissionStaff(db,company,team,user);return result(true);}
    mapError(error);
  }
}
