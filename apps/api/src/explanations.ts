import { z } from 'zod';
import { optimizerInputSchema,type OptimizerInput } from '../../../packages/contracts/optimizer-input.generated';
import { readJobResult,loadJob } from './compute-jobs';
import { readDraft } from './schedule-drafts';
import { snapshotDraftStale } from './draft-lineage';
import { readInputSnapshot,sha256 } from './input-snapshots';
import { ProductError,requireManager } from './product';
import type { InputDatabase } from './input-versions';
import { explanationSource,explanationCommand,explanationGrounds,type ExplanationGrounds,type ExplanationResponse } from './explanation-contract';
import { groundFacts,PROMPT_VERSION,summaryPacket,validateSummary,templateSummary } from './explanation-grounding';

export const EXPLANATION_MODEL='@cf/meta/llama-3.3-70b-instruct-fp8-fast';
type Environment={DB:InputDatabase;INPUTS:R2Bucket};
const hash=(data:unknown)=>sha256(new TextEncoder().encode(JSON.stringify(data)));
export async function readExplanationGrounds(env:Environment,company:string,team:string,user:string,raw:z.infer<typeof explanationSource>):Promise<ExplanationGrounds>{
  const source=explanationSource.parse(raw);await requireManager(env.DB,company,team,user);
  let snapshotId:string,jobId:string,resultDigest:string,inputDigest:string,validation:unknown,solverStatus:string,hasAssignments:boolean,stale:boolean,input:OptimizerInput;
  if(source.kind==='job'){
    const job=await loadJob(env.DB,company,team,source.id);if(!job)throw new ProductError('NOT_FOUND',404);
    const saved=await readJobResult(env.DB,env.INPUTS,company,team,user,source.id),r=z.object({snapshotId:z.string().uuid(),snapshotSha256:z.string(),inputSha256:z.string(),solverStatus:z.string(),assignments:z.array(z.unknown()).nullable(),validation:z.unknown()}).passthrough().parse(saved.result);
    snapshotId=job.snapshot_id;jobId=job.id;resultDigest=job.result_sha256!;inputDigest=r.inputSha256;validation=r.validation;solverStatus=r.solverStatus;hasAssignments=r.assignments!==null;stale=saved.stale;
    const frozen=await readInputSnapshot(env.DB,env.INPUTS,company,team,user,snapshotId);
    if(r.snapshotId!==snapshotId||r.snapshotSha256!==frozen.snapshot.sha256||await hash(optimizerInputSchema.parse({...frozen.input,jobId,attempt:job.attempt}))!==inputDigest)throw new Error('EXPLANATION_INPUT_MISMATCH');
    input=frozen.input;stale||=frozen.stale;
  }else{
    const saved=await readDraft(env,company,team,user,source.id),d=saved.draft;
    const row=await env.DB.prepare('SELECT sha256 FROM schedule_draft_version WHERE company_id=? AND id=? AND team_id=?').bind(company,source.id,team).first<string>('sha256');
    if(!row)throw new ProductError('NOT_FOUND',404);
    snapshotId=d.snapshotId;jobId=d.sourceJobId;resultDigest=row;inputDigest=d.inputSha256;validation=d.validation;solverStatus='MANUAL';hasAssignments=true;stale=saved.stale||saved.superseded;
    const frozen=await readInputSnapshot(env.DB,env.INPUTS,company,team,user,snapshotId);
    input=optimizerInputSchema.parse({...frozen.input,locks:d.locks,exceptions:d.exceptions});
    if(d.snapshotSha256!==frozen.snapshot.sha256||await hash(input)!==inputDigest)throw new Error('EXPLANATION_INPUT_MISMATCH');
  }
  const facts=groundFacts(input,validation,solverStatus,hasAssignments);
  const identity={version:'explanation-v1' as const,source,month:input.month,jobId,snapshotId,inputRevision:input.inputVersion,resultDigest,inputDigest,solverStatus,...facts};
  await requireManager(env.DB,company,team,user);
  const revision=await env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(company).first<number>('revision');
  const head=await env.DB.prepare('SELECT draft_id,revision FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?').bind(company,team,input.month).first<{draft_id:string|null;revision:number}>();
  const draftChanged=source.kind==='draft'?head?.draft_id!==source.id:await snapshotDraftStale(env.DB,company,snapshotId);
  return explanationGrounds.parse({...identity,digest:await hash(identity),stale:stale||draftChanged||revision!==input.inputVersion,currentDraftId:head?.draft_id??null,currentDraftRevision:head?.revision??0});
}
export type SummaryProvider=(packet:ReturnType<typeof summaryPacket>,signal:AbortSignal)=>Promise<unknown>;
export type ExplanationInference=(request:{messages:{role:'system'|'user';content:string}[];max_tokens:number;temperature:number;response_format:{type:'json_schema';json_schema:object}},signal:AbortSignal)=>Promise<unknown>;
export function workersSummaryProvider(infer:ExplanationInference):SummaryProvider {
  return async(packet,signal)=>{
    const result=await infer({messages:[
      {role:'system',content:'日本語のシフト配置結果を短く要約してください。与えた検証済み根拠文から重要な2〜5文を選び、読みやすい順に並べます。solverとvalidationは必ず含めます。数値、言葉、句読点は変更せず、文の追加・推測・原因断定は禁止です。factIdsには選択順のID、summaryには同じ順の根拠文を改行だけで結合します。JSONだけを返してください。'},
      {role:'user',content:JSON.stringify({facts:packet})}],max_tokens:768,temperature:0,
      response_format:{type:'json_schema',json_schema:{type:'object',properties:{factIds:{type:'array',minItems:2,maxItems:5,items:{type:'string'}},summary:{type:'string'}},required:['factIds','summary'],additionalProperties:false}}},signal);
    const parsed=z.object({response:z.union([z.string().max(10000),z.record(z.string(),z.unknown())])}).safeParse(result);
    if(!parsed.success)throw new Error('AI_FORMAT');return typeof parsed.data.response==='string'?JSON.parse(parsed.data.response):parsed.data.response;
  };
}
type Row={id:string;fingerprint:string;state:'PENDING'|'SUCCEEDED'|'FAILED';summary:string|null;fact_ids:string|null;reason:string|null;generated_at:number|null;created_at:number;expired:number;model:string;prompt_version:string};
const readRow=(db:InputDatabase,company:string,sql:string,params:unknown[])=>db.prepare(`SELECT *,created_at<=CAST(strftime('%s','now') AS INTEGER)*1000-30000 AS expired FROM schedule_explanation WHERE company_id=? AND ${sql}`).bind(company,...params).first<Row>();
async function key(grounds:ExplanationGrounds){return hash({digest:grounds.digest,model:EXPLANATION_MODEL,promptVersion:PROMPT_VERSION});}
function reply(grounds:ExplanationGrounds,row:Row|null,reason:string|null,cached=false):ExplanationResponse{
  const checked=row?.state==='SUCCEEDED'&&row.fact_ids?validateSummary({summary:row.summary,factIds:JSON.parse(row.fact_ids)},grounds.facts):null;
  const summary=checked??templateSummary(grounds.facts);
  return {grounds,mode:checked?'ai':row?.state==='PENDING'&&!row.expired?'pending':'template',...summary,
    reason:checked?null:reason??(row?.expired&&row.state==='PENDING'?'TIMEOUT':row?.reason??null),model:row?.model??null,promptVersion:row?.prompt_version??PROMPT_VERSION,generatedAt:row?.generated_at??null,operationId:row?.id??null,cached};
}
export async function readExplanation(env:Environment,company:string,team:string,user:string,source:z.infer<typeof explanationSource>){
  const grounds=await readExplanationGrounds(env,company,team,user,source),k=await key(grounds);
  const row=await readRow(env.DB,company,"team_id=? AND cache_key=? ORDER BY CASE state WHEN 'SUCCEEDED' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END,created_at DESC,id LIMIT 1",[team,k]);
  await requireManager(env.DB,company,team,user);return reply(grounds,row,null,!!row);
}
export async function generateExplanation(env:Environment,company:string,team:string,user:string,raw:z.infer<typeof explanationCommand>,provider?:SummaryProvider):Promise<ExplanationResponse>{
  const c=explanationCommand.parse(raw),db=env.DB,grounds=await readExplanationGrounds(env,company,team,user,c.source);
  if(c.digest!==grounds.digest)throw new ProductError('EXPLANATION_SOURCE_CONFLICT');
  const fingerprint=await hash({company,team,user,command:c}),k=await key(grounds);
  const old=await readRow(db,company,'id=?',[c.operationId]);if(old){if(old.fingerprint!==fingerprint)throw new ProductError('OPERATION_ID_CONFLICT');await requireManager(db,company,team,user);return reply(grounds,old,null,true);}
  const cached=await readRow(db,company,"team_id=? AND cache_key=? AND state IN ('PENDING','SUCCEEDED')",[team,k]);
  await requireManager(db,company,team,user);
  if(cached&&(!cached.expired||cached.state==='SUCCEEDED'))return reply(grounds,cached,null,true);
  if(grounds.stale)return reply(grounds,null,'STALE_SOURCE');
  if(!grounds.metricsAvailable)return reply(grounds,null,'INSUFFICIENT_GROUNDS');
  if(!provider)return reply(grounds,null,'AI_DISABLED');
  const packet=summaryPacket(grounds.facts),packetJson=JSON.stringify(packet);
  if(new TextEncoder().encode(packetJson).byteLength>16000)return reply(grounds,null,'INSUFFICIENT_GROUNDS');
  try{
    await db.batch([
      db.prepare("UPDATE schedule_explanation SET state='FAILED',reason='TIMEOUT',generated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE company_id=? AND team_id=? AND state='PENDING' AND created_at<=CAST(strftime('%s','now') AS INTEGER)*1000-30000").bind(company,team),
      db.prepare('INSERT INTO schedule_explanation(company_id,id,team_id,actor_id,source_kind,source_id,input_revision,grounds_digest,cache_key,fingerprint,model,prompt_version,month,head_id,head_revision,source_digest,packet,grounds_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(company,c.operationId,team,user,c.source.kind,c.source.id,grounds.inputRevision,grounds.digest,k,fingerprint,EXPLANATION_MODEL,PROMPT_VERSION,grounds.month,grounds.currentDraftId,grounds.currentDraftRevision,grounds.resultDigest,packetJson,grounds.version),
    ]);
  }catch(error){
    const same=await readRow(db,company,'id=?',[c.operationId]);if(same){if(same.fingerprint!==fingerprint)throw new ProductError('OPERATION_ID_CONFLICT');await requireManager(db,company,team,user);return reply(grounds,same,null,true);}
    await requireManager(db,company,team,user);
    const other=await readRow(db,company,"team_id=? AND cache_key=? AND state IN ('PENDING','SUCCEEDED')",[team,k]);if(other)return reply(grounds,other,null,true);
    const text=String(error);for(const code of ['EXPLANATION_LIMIT','EXPLANATION_BUSY','EXPLANATION_STALE'])if(text.includes(code))return reply(code==='EXPLANATION_STALE'?await readExplanationGrounds(env,company,team,user,c.source):grounds,null,code);
    throw error;
  }
  let completed:ReturnType<typeof validateSummary>=null,reason:string|null=null;
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try{
    // The race also bounds injected/external adapters that ignore AbortSignal.
    const abort=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('AI_TIMEOUT')),{once:true}));
    completed=validateSummary(await Promise.race([provider(packet,controller.signal),abort]),grounds.facts);
    if(!completed)reason='OUTPUT_MISMATCH';
  }catch{reason=controller.signal.aborted?'TIMEOUT':'PROVIDER_ERROR';}finally{clearTimeout(timeout);}
  await db.prepare('UPDATE schedule_explanation SET state=?,summary=?,fact_ids=?,reason=?,generated_at=CAST(strftime(\'%s\',\'now\') AS INTEGER)*1000 WHERE company_id=? AND id=? AND state=\'PENDING\'')
    .bind(completed?'SUCCEEDED':'FAILED',completed?.summary??null,completed?JSON.stringify(completed.factIds):null,reason,company,c.operationId).run();
  // Never respond using authorization or version observations made before AI.
  const current=await readExplanationGrounds(env,company,team,user,c.source);
  if(current.digest!==grounds.digest)throw new ProductError('EXPLANATION_SOURCE_CONFLICT');
  const row=await readRow(db,company,'id=?',[c.operationId]);
  await requireManager(db,company,team,user);return reply(current,row,reason);
}
export async function pruneExplanations(db:InputDatabase){
  return db.prepare("DELETE FROM schedule_explanation WHERE created_at<CAST(strftime('%s','now') AS INTEGER)*1000-2592000000").run();
}
