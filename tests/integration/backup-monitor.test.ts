import {env} from 'cloudflare:test';
import {describe,it,expect,vi} from 'vitest';
import monitor,{backupHealth,pruneRemoteBackups} from '../../apps/operations/src/backup-monitor';
import {BACKUP_BUCKET,RETENTION_MS,MAX_AGE_MS,markerKey,archiveKey,type RemoteBackupMarker} from '../../scripts/remote-backup-contract.mjs';

const now=Date.UTC(2026,9,11,12),source={mode:'remote' as const,databaseId:'11111111-2222-4333-8444-555555555555',bucket:'shift-manager-example-inputs'};
function marker(age=0):RemoteBackupMarker{
  return {version:'shift-remote-backup-v1',id:crypto.randomUUID(),bucket:BACKUP_BUCKET,source,createdAt:now-age,completedAt:now-age,publishedAt:now-age,expiresAt:now-age+RETENTION_MS,sqlSha256:'0'.repeat(64),manifestSha256:'1'.repeat(64),archive:{sha256:'2'.repeat(64),bytes:3},counts:{tables:65,objects:30}};
}
async function write(m:RemoteBackupMarker){await env.INPUTS.put(archiveKey(m.id),'zip');await env.INPUTS.put(markerKey(m.id),JSON.stringify(m));}
async function clear(m:RemoteBackupMarker){await env.INPUTS.delete([archiveKey(m.id),markerKey(m.id)]);}

describe('dedicated backup monitor with actual local R2 binding',()=>{
  it('reports source capture age, warning and 24-hour stale boundary without renewing it from upload time',async()=>{
    for(const [age,status] of [[0,'HEALTHY'],[18*60*60*1000,'AGING'],[MAX_AGE_MS-1,'AGING'],[MAX_AGE_MS,'STALE']] as const){
      const m=marker(age);m.publishedAt=now;await write(m);
      try{const report=await backupHealth(env.INPUTS,now);expect(report.status).toBe(status);expect(report.ageMs).toBe(age);}
      finally{await clear(m);}
    }
  });
  it('does not count a local rehearsal or a copy without completion; detects missing or changed-size archive',async()=>{
    const local=marker();local.source={mode:'local',databaseId:'00000000-0000-0000-0000-000000000000',bucket:'shift-planner-inputs-local'};await write(local);
    const m=marker();await env.INPUTS.put(archiveKey(m.id),'zip');
    try{
      expect((await backupHealth(env.INPUTS,now)).status).toBe('MISSING');await env.INPUTS.put(markerKey(m.id),JSON.stringify(m));await env.INPUTS.delete(archiveKey(m.id));expect((await backupHealth(env.INPUTS,now)).status).toBe('CORRUPT');
      await env.INPUTS.put(archiveKey(m.id),'wrong size');expect((await backupHealth(env.INPUTS,now)).status).toBe('CORRUPT');await env.INPUTS.put(archiveKey(m.id),'zip');expect((await backupHealth(env.INPUTS,now)).status).toBe('HEALTHY');
    }finally{await clear(local);await clear(m);}
  });
  it('rejects marker-key substitution and invalid JSON without logging payloads',async()=>{
    const m=marker(),key=markerKey(crypto.randomUUID());await env.INPUTS.put(key,JSON.stringify(m));
    try{expect((await backupHealth(env.INPUTS,now)).status).toBe('CORRUPT');await env.INPUTS.put(key,'malformed');expect((await backupHealth(env.INPUTS,now)).status).toBe('CORRUPT');}
    finally{await env.INPUTS.delete(key);}
  });
  it('30-day pruning deletes only validated expired recovery keys and preserves newer, malformed and source objects',async()=>{
    const expired=marker(RETENTION_MS),fresh=marker(),invalidKey=markerKey(crypto.randomUUID()),sourceKey='fictional-source/'+crypto.randomUUID();await write(expired);await write(fresh);await env.INPUTS.put(invalidKey,'malformed');await env.INPUTS.put(sourceKey,'source');
    try{
      expect((await pruneRemoteBackups(env.INPUTS,now-1)).removed).toBe(0);expect((await pruneRemoteBackups(env.INPUTS,now)).removed).toBe(1);expect(await env.INPUTS.head(archiveKey(expired.id))).toBeNull();expect(await env.INPUTS.head(markerKey(expired.id))).toBeNull();expect(await env.INPUTS.head(archiveKey(fresh.id))).not.toBeNull();expect(await env.INPUTS.head(invalidKey)).not.toBeNull();expect(await(await env.INPUTS.get(sourceKey))!.text()).toBe('source');
    }finally{await clear(expired);await clear(fresh);await env.INPUTS.delete([invalidKey,sourceKey]);}
  });
  it('operator endpoints require a separate token, return no-store and never serve raw backups',async()=>{
    const token=crypto.randomUUID()+crypto.randomUUID(),bindings={BACKUPS:env.INPUTS,BACKUP_MONITOR_TOKEN:token},headers={authorization:'Bearer '+token};
    for(const url of ['/health','/prune','/recovery/data/anything.zip']){const r=await monitor.fetch(new Request('https://monitor.example'+url),bindings);expect(r.status).toBe(403);expect(r.headers.get('cache-control')).toBe('no-store');}
    const wrongToken=crypto.randomUUID()+crypto.randomUUID();expect((await monitor.fetch(new Request('https://monitor.example/health',{headers:{authorization:'Bearer '+wrongToken}}),bindings)).status).toBe(403);
    const health=await monitor.fetch(new Request('https://monitor.example/health',{headers}),bindings);expect(health.status).toBe(503);expect((await health.json() as {status:string}).status).toBe('MISSING');expect(health.headers.get('cache-control')).toBe('no-store');
    expect((await monitor.fetch(new Request('https://monitor.example/recovery/data/anything.zip',{headers}),bindings)).status).toBe(404);
    const prune=await monitor.fetch(new Request('https://monitor.example/prune',{method:'POST',headers}),bindings);expect(prune.status).toBe(200);expect(prune.headers.get('cache-control')).toBe('no-store');
  });
  it('scheduled handler prunes expired copies and emits a healthy metadata report',async()=>{
    const clock=Date.now(),fresh=marker(),expired=marker();
    for(const [m,time] of [[fresh,clock],[expired,clock-RETENTION_MS]] as const){m.createdAt=time;m.completedAt=time;m.publishedAt=time;m.expiresAt=time+RETENTION_MS;await write(m);}
    const log=vi.spyOn(console,'log').mockImplementation(()=>{});
    try{
      await monitor.scheduled({scheduledTime:clock,cron:'23 * * * *',noRetry(){}},{BACKUPS:env.INPUTS,BACKUP_MONITOR_TOKEN:crypto.randomUUID()});
      expect(await env.INPUTS.head(markerKey(expired.id))).toBeNull();expect(await env.INPUTS.head(archiveKey(fresh.id))).not.toBeNull();
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({status:'HEALTHY',expiredCopiesRemoved:1,latestBackupId:fresh.id});
    }finally{log.mockRestore();await clear(fresh);await clear(expired);}
  });
  it('scheduled handler fails on a missing recovery copy and does not expose contents',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    try{
      await expect(monitor.scheduled({scheduledTime:Date.now(),cron:'23 * * * *',noRetry(){}},{BACKUPS:env.INPUTS,BACKUP_MONITOR_TOKEN:crypto.randomUUID()})).rejects.toThrow('BACKUP_MONITOR_FAILED');
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({status:'MISSING',healthy:false});expect(JSON.parse(log.mock.calls[1][0])).toEqual({component:'backup-monitor',status:'CHECK_FAILED'});
    }finally{log.mockRestore();}
  });
});
