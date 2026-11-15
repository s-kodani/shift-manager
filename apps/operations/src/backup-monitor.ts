import {MAX_AGE_MS,archiveKey,markerKey,validateMarker,type RemoteBackupMarker} from '../../../scripts/remote-backup-contract.mjs';
import type {BackupMonitorEnv} from '../worker-configuration';

export async function pruneRemoteBackups(bucket:R2Bucket,now=Date.now()){
  const listed=await bucket.list({prefix:'recovery/complete/',limit:1000});
  if(listed.truncated)throw new Error('BACKUP_LIST_OVERFLOW');
  let removed=0;
  for(const item of listed.objects){
    if(item.size>8000)continue;const object=await bucket.get(item.key);if(!object||object.size>8000)continue;
    let marker:RemoteBackupMarker;try{marker=validateMarker(await object.json(),{now,allowExpired:true});}catch{continue;}
    if(item.key!==markerKey(marker.id)||marker.expiresAt>now)continue;
    // Delete archive first. A failed delete leaves its marker for reconciliation.
    await bucket.delete(archiveKey(marker.id));await bucket.delete(markerKey(marker.id));removed++;
  }
  return{removed};
}

export async function backupHealth(bucket:R2Bucket,now=Date.now()){
  const listed=await bucket.list({prefix:'recovery/complete/',limit:1000});
  if(listed.truncated)return {status:'OVERFLOW',healthy:false,at:now,invalidCopies:0};
  let invalid=0,expired=0,local=0;const markers:RemoteBackupMarker[]=[];
  for(const item of listed.objects){
    try{
      if(item.size>8000)throw new Error('OVERSIZED_MARKER');
      const object=await bucket.get(item.key);if(!object||object.size>8000)throw new Error('MISSING_OR_OVERSIZED_MARKER');
      const marker=validateMarker(await object.json(),{now,allowExpired:true});
      if(item.key!==markerKey(marker.id))throw new Error('MARKER_KEY_MISMATCH');
      if(marker.expiresAt<=now){expired++;continue;}
      if(marker.source.mode!=='remote'){local++;continue;}
      const archive=await bucket.head(archiveKey(marker.id));
      if(!archive||archive.size!==marker.archive.bytes)throw new Error('ARCHIVE_MISSING_OR_SIZE');
      markers.push(marker);
    }catch{invalid++;}
  }
  markers.sort((a,b)=>b.createdAt-a.createdAt||b.completedAt-a.completedAt||b.id.localeCompare(a.id));
  const latest=markers[0];const age=latest?Math.max(0,now-latest.createdAt):null;
  const status=invalid?'CORRUPT':!latest?'MISSING':age!==null&&age>=MAX_AGE_MS?'STALE':age!==null&&age>=18*60*60*1000?'AGING':'HEALTHY';
  return {status,healthy:['HEALTHY','AGING'].includes(status),at:now,latestBackupId:latest?.id??null,sourceCapturedAt:latest?.createdAt??null,ageMs:age,invalidCopies:invalid,expiredCopies:expired,localCopiesIgnored:local,
    verificationScope:'completion marker and archive presence/size; byte hash and full contents verified by publisher/download tools'};
}

async function authorized(request:Request,token:string){
  if(!token)return false;
  const actual=new TextEncoder().encode(request.headers.get('authorization')??''),expected=new TextEncoder().encode('Bearer '+token);
  return actual.length===expected.length&&crypto.subtle.timingSafeEqual(actual,expected);
}
export default {
  async fetch(request,env){
    if(!await authorized(request,env.BACKUP_MONITOR_TOKEN))return Response.json({error:'FORBIDDEN'},{status:403,headers:{'cache-control':'no-store'}});
    if(request.method==='POST'&&new URL(request.url).pathname==='/prune'){
      try{return Response.json(await pruneRemoteBackups(env.BACKUPS),{headers:{'cache-control':'no-store'}});}
      catch{return Response.json({error:'PRUNE_FAILED'},{status:503,headers:{'cache-control':'no-store'}});}
    }
    if(request.method!=='GET'||new URL(request.url).pathname!=='/health')return Response.json({error:'NOT_FOUND'},{status:404,headers:{'cache-control':'no-store'}});
    try{const report=await backupHealth(env.BACKUPS);return Response.json(report,{status:report.healthy?200:503,headers:{'cache-control':'no-store'}});}
    catch{return Response.json({status:'MONITOR_FAILED',healthy:false},{status:503,headers:{'cache-control':'no-store'}});}
  },
  async scheduled(_event,env){
    try{
      const pruning=await pruneRemoteBackups(env.BACKUPS);
      const report=await backupHealth(env.BACKUPS);
      const output=JSON.stringify({component:'backup-monitor',...report,expiredCopiesRemoved:pruning.removed});
      if(report.healthy)console.log(output);else{console.error(output);throw new Error('BACKUP_MONITOR_UNHEALTHY');}
    }catch{console.error(JSON.stringify({component:'backup-monitor',status:'CHECK_FAILED'}));throw new Error('BACKUP_MONITOR_FAILED');}
  },
} satisfies ExportedHandler<BackupMonitorEnv>;
