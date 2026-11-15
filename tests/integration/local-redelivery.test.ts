import {env,applyD1Migrations,createExecutionContext} from 'cloudflare:test';
import {beforeAll,it,expect,vi} from 'vitest';
import worker from '../../apps/api/src/local-ui-worker';
import {inputFixture} from '../../apps/api/src/input-probes';
import {executeJob} from '../../apps/api/src/compute-execution';
const token=crypto.randomUUID()+crypto.randomUUID();
const request=(body:object,auth='Bearer '+token,url='http://localhost:8787')=>new Request(url+'/__local/redeliver',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(body)});
beforeAll(()=>applyD1Migrations(env.DB,env.TEST_MIGRATIONS));
async function fixture(){const f=await inputFixture(env.DB,env.INPUTS),id=crypto.randomUUID();await env.DB.prepare('CREATE TABLE IF NOT EXISTS local_ui_fixture(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,expires_at INTEGER NOT NULL,cleaned_at INTEGER)').run();await env.DB.prepare('INSERT INTO local_ui_fixture VALUES (?,?,?,NULL)').bind(id,f.company.companyId,Date.now()+60000).run();return {fixtureId:id,teamId:f.team,companyId:f.company.companyId,jobId:crypto.randomUUID()};}
it('redelivers only the canonical message for a live owned team, including an obsolete missing job',async()=>{
 const f=await fixture(),send=vi.fn().mockResolvedValue(undefined),{companyId,...body}=f;
 const r=await worker.fetch(request(body),{...env,ENVIRONMENT:'local',POC_TOKEN:token,RECOVERY_SECURITY_ID:'',COMPUTE_QUEUE:{send} as unknown as Queue},createExecutionContext());
 expect(r.status).toBe(200);expect(send).toHaveBeenCalledExactlyOnceWith({version:1,companyId,teamId:f.teamId,jobId:f.jobId});expect(await env.DB.prepare('SELECT count(*) n FROM compute_job').first('n')).toBe(0);
 const ack=vi.fn(),retry=vi.fn();const message={id:crypto.randomUUID(),timestamp:new Date(),body:{version:1,companyId,teamId:f.teamId,jobId:f.jobId},attempts:1,ack,retry};
 const runJob=vi.fn().mockImplementation(async (body)=>executeJob(env,body,async()=>{throw Error('MISSING_JOB_REACHED_CONTAINER');},async()=>{}));
 await worker.queue({queue:'fictional-local',metadata:{metrics:{backlogCount:0,backlogBytes:0}},messages:[message],ackAll:vi.fn(),retryAll:vi.fn()}, {...env,ENVIRONMENT:'local',SOLVER:{getByName:()=>({runJob})} as unknown as Env['SOLVER']});
 expect(runJob).toHaveBeenCalledOnce();
 expect(ack).toHaveBeenCalledOnce();expect(retry).not.toHaveBeenCalled();expect(await env.DB.prepare('SELECT state FROM local_redelivery_probe WHERE job_id=?').bind(f.jobId).first('state')).toBe('ACKED');expect(await env.DB.prepare('SELECT count(*) n FROM compute_attempt').first('n')).toBe(0);
 await env.DB.prepare("UPDATE local_redelivery_probe SET state='DISPATCHED' WHERE job_id=?").bind(f.jobId).run();await env.DB.prepare("UPDATE maintenance_state SET mode='FROZEN' WHERE id=1").run();ack.mockClear();retry.mockClear();
 try{await worker.queue({queue:'fictional-local',metadata:{metrics:{backlogCount:0,backlogBytes:0}},messages:[message],ackAll:vi.fn(),retryAll:vi.fn()}, {...env,ENVIRONMENT:'local'});expect(retry).toHaveBeenCalledOnce();expect(ack).not.toHaveBeenCalled();expect(await env.DB.prepare('SELECT state FROM local_redelivery_probe WHERE job_id=?').bind(f.jobId).first('state')).toBe('DISPATCHED');}finally{await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN' WHERE id=1").run();}
});
it('rejects another team, expired or cleaned fixture, malformed message and unauthenticated or remote callers',async()=>{
 const f=await fixture(),send=vi.fn(),bindings={...env,ENVIRONMENT:'local',POC_TOKEN:token,RECOVERY_SECURITY_ID:'',COMPUTE_QUEUE:{send} as unknown as Queue},{companyId,...body}=f;
 expect((await worker.fetch(request({...body,teamId:crypto.randomUUID()}),bindings,createExecutionContext())).status).toBe(404);
 for(const [auth,url,mode] of [['','http://localhost:8787','local'],['Bearer '+token,'https://example.invalid','local'],['Bearer '+token,'http://localhost:8787','poc']])expect((await worker.fetch(request(body,auth,url),{...bindings,ENVIRONMENT:mode},createExecutionContext())).status).toBe(403);
 expect((await worker.fetch(request({...body,jobId:'invalid'}),bindings,createExecutionContext())).status).toBe(500);
 await env.DB.prepare('UPDATE local_ui_fixture SET expires_at=0 WHERE id=?').bind(f.fixtureId).run();expect((await worker.fetch(request(body),bindings,createExecutionContext())).status).toBe(404);
 await env.DB.prepare('UPDATE local_ui_fixture SET expires_at=?,cleaned_at=? WHERE id=?').bind(Date.now()+60000,Date.now(),f.fixtureId).run();expect((await worker.fetch(request(body),bindings,createExecutionContext())).status).toBe(404);expect(send).not.toHaveBeenCalled();
});
it('cannot bypass a frozen environment or unreconciled restore to send a Queue message',async()=>{
 const f=await fixture(),send=vi.fn(),bindings={...env,ENVIRONMENT:'local',POC_TOKEN:token,COMPUTE_QUEUE:{send} as unknown as Queue},{companyId,...body}=f;
 expect((await worker.fetch(request(body),{...bindings,RECOVERY_SECURITY_ID:crypto.randomUUID()},createExecutionContext())).status).toBe(503);
 await env.DB.prepare("UPDATE maintenance_state SET mode='FROZEN' WHERE id=1").run();try{expect((await worker.fetch(request(body),{...bindings,RECOVERY_SECURITY_ID:''},createExecutionContext())).status).toBe(503);}finally{await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN' WHERE id=1").run();}
 expect(send).not.toHaveBeenCalled();expect(await env.DB.prepare('SELECT count(*) n FROM maintenance_lease').first('n')).toBe(0);
});
