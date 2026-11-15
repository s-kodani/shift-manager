import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,beforeEach,expect,it} from 'vitest';
import {inputFixture} from '../../apps/api/src/input-probes';
import {createInputSnapshot} from '../../apps/api/src/input-snapshots';
import {createJob,claimJob,cancelJob,type JobMessage} from '../../apps/api/src/compute-jobs';
import {authorizeFault,faultEvidence,type FaultCommand} from '../../apps/api/src/compute-faults';

let f:Awaited<ReturnType<typeof inputFixture>>,message:JobMessage,command:FaultCommand;
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{
 f=await inputFixture(env.DB);const snapshotId=crypto.randomUUID(),id=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
 await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:id,snapshotId,expectedRevision:f.revision});
 message={version:1,companyId:f.company.companyId,teamId:f.team,jobId:id};
 command={operationId:crypto.randomUUID(),probeId:id,expectedAttempt:1,mode:'restart'};
 await env.DB.prepare('INSERT INTO compute_probe(id,company_id,team_id,admin_user_id,staff_user_id,results,expires_at) VALUES (?,?,?,?,?,?,?)')
  .bind(id,f.company.companyId,f.team,f.company.userId,f.staffUser,'[]',Date.now()+60_000).run();
 await claimJob(env.DB,message);
});
it('fault controls reject other environments even when a fictional job is running',async()=>{
 for(const environment of ['local','production','staging'])await expect(authorizeFault(env.DB,environment,message,command)).rejects.toThrow('FORBIDDEN');
 await expect(authorizeFault(env.DB,'poc',message,command)).resolves.toBeUndefined();
 // The test pool does not enable Container execution. Actual reset/crash RPC
 // behavior is verified separately in the dedicated native environment.
 expect(await faultEvidence(env.DB,command)).toBeNull();
});
it('fault controls reject wrong ownership, attempt, expired and cleaned probes',async()=>{
 await expect(authorizeFault(env.DB,'poc',{...message,companyId:crypto.randomUUID()},command)).rejects.toThrow('FAULT_NOT_ALLOWED');
 await expect(authorizeFault(env.DB,'poc',{...message,teamId:crypto.randomUUID()},command)).rejects.toThrow('FAULT_NOT_ALLOWED');
 await expect(authorizeFault(env.DB,'poc',{...message,jobId:crypto.randomUUID()},command)).rejects.toThrow('FORBIDDEN');
 await expect(authorizeFault(env.DB,'poc',message,{...command,expectedAttempt:2})).rejects.toThrow('FAULT_NOT_ALLOWED');
 await expect(authorizeFault(env.DB,'poc',message,command,Date.now()+61_000)).rejects.toThrow('FAULT_NOT_ALLOWED');
 await env.DB.prepare('UPDATE compute_probe SET cleaned_at=? WHERE id=?').bind(Date.now(),message.jobId).run();
 await expect(authorizeFault(env.DB,'poc',message,command)).rejects.toThrow('FAULT_NOT_ALLOWED');
});
it('fault controls do not interrupt a job already cancelling',async()=>{
 await cancelJob(env.DB,message.companyId,message.teamId,f.company.userId,message.jobId,{operationId:crypto.randomUUID(),expectedAttempt:1});
 await expect(authorizeFault(env.DB,'poc',message,command)).rejects.toThrow('FAULT_NOT_ALLOWED');
});
it('fault evidence has immutable identity and write-once observations; retry cannot change targets',async()=>{
 await env.DB.prepare('INSERT INTO compute_fault_probe(id,probe_id,attempt,mode,before_boot,requested_at) VALUES (?,?,?,?,?,?)')
  .bind(command.operationId,command.probeId,1,'restart','first-boot',Date.now()).run();
 expect(await faultEvidence(env.DB,command)).toMatchObject({probe_id:message.jobId,mode:'restart',before_boot:'first-boot'});
 await expect(faultEvidence(env.DB,{...command,mode:'crash'})).rejects.toThrow('OPERATION_ID_CONFLICT');
 await expect(faultEvidence(env.DB,{...command,probeId:crypto.randomUUID()})).rejects.toThrow('OPERATION_ID_CONFLICT');
 await env.DB.prepare('UPDATE compute_fault_probe SET after_boot=?,after_process_running=1,observed_at=? WHERE id=?').bind('second-boot',Date.now(),command.operationId).run();
 await env.DB.prepare('UPDATE compute_fault_probe SET recovery_boot=?,recovery_stopped_at=? WHERE id=?').bind('second-boot',Date.now(),command.operationId).run();
 await expect(env.DB.prepare("UPDATE compute_fault_probe SET after_boot='third-boot' WHERE id=?").bind(command.operationId).run()).rejects.toThrow('IMMUTABLE_FAULT_OBSERVATION');
 await expect(env.DB.prepare("UPDATE compute_fault_probe SET recovery_boot='third-boot' WHERE id=?").bind(command.operationId).run()).rejects.toThrow('IMMUTABLE_FAULT_RECOVERY');
 await expect(env.DB.prepare('DELETE FROM compute_fault_probe WHERE id=?').bind(command.operationId).run()).rejects.toThrow('IMMUTABLE_FAULT_EVIDENCE');
});
