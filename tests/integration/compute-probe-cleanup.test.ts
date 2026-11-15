import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {inputFixture} from '../../apps/api/src/input-probes';
import {createInputSnapshot} from '../../apps/api/src/input-snapshots';
import {createJob,cancelJob} from '../../apps/api/src/compute-jobs';
import {cleanupComputeProbe} from '../../apps/api/src/compute-probes';

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
it('a terminal job is not marked cleaned while its object still owns execution',async()=>{
 const f=await inputFixture(env.DB),id=crypto.randomUUID(),snapshotId=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
 await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:id,snapshotId,expectedRevision:f.revision});
 await cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,id,{operationId:crypto.randomUUID(),expectedAttempt:0});
 await env.DB.prepare('INSERT INTO compute_probe(id,company_id,team_id,admin_user_id,staff_user_id,results,expires_at) VALUES (?,?,?,?,?,?,?)')
  .bind(id,f.company.companyId,f.team,f.company.userId,f.staffUser,'[]',Date.now()+60_000).run();
 let released=false;
 const bound={...env,SOLVER:{getByName:()=>({releaseIdleProbe:async()=>({released})})}} as unknown as Env;
 expect(await cleanupComputeProbe(bound,id)).toMatchObject({cleaned:false,processReleased:false,cleanupPending:true});
 expect(await env.DB.prepare('SELECT cleaned_at FROM compute_probe WHERE id=?').bind(id).first()).toMatchObject({cleaned_at:null});
 expect(await env.DB.prepare('SELECT enabled FROM access_state WHERE user_id=?').bind(f.company.userId).first()).toMatchObject({enabled:1});
 released=true;
 expect(await cleanupComputeProbe(bound,id)).toMatchObject({cleaned:true,processReleased:true});
 expect((await env.DB.prepare('SELECT cleaned_at FROM compute_probe WHERE id=?').bind(id).first<{cleaned_at:number|null}>())?.cleaned_at).not.toBeNull();
 expect(await env.DB.prepare('SELECT enabled FROM access_state WHERE user_id=?').bind(f.company.userId).first()).toMatchObject({enabled:0});
});
