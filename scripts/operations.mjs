import {startBackup,resumeBackup,verifyBackup,restoreBackup,reconcileImport,verifyRestored,pruneBackups} from './backup-lib.mjs';
import {mkdir,chmod,writeFile,readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {publishBackup,downloadBackup} from './remote-backup.mjs';
import {prepareSchemaUpgrade,applySchemaUpgrade,verifySchemaUpgrade} from './backup-schema-upgrade.mjs';
const [action,a,b]=process.argv.slice(2);
const owner=randomUUID(),lock='.cache/operations.lock';let acquired=false;
try{
  await mkdir('.cache',{recursive:true,mode:0o700});await mkdir('.cache/operations-diagnostics',{recursive:true,mode:0o700});await chmod('.cache/operations-diagnostics',0o700);
  await writeFile(lock,JSON.stringify({owner,pid:process.pid,action,startedAt:Date.now()}),{mode:0o600,flag:'wx'});acquired=true;
  if(action==='backup'&&['--local','--remote'].includes(a))await startBackup(a==='--remote');
  else if(action==='backup-and-publish'){const {manifest}=await startBackup(true);console.log(JSON.stringify(await publishBackup(manifest.id)));}
  else if(action==='publish')console.log(JSON.stringify(await publishBackup(a)));
  else if(action==='download')console.log(JSON.stringify(await downloadBackup(a)));
  else if(action==='resume')await resumeBackup(a);
  else if(action==='verify'){const {manifest}=await verifyBackup(a);console.log(JSON.stringify({backupId:a,verified:true,objects:manifest.catalog.objects.length}));}
  else if(action==='restore')console.log(JSON.stringify(await restoreBackup(a,b)));
  else if(action==='reconcile-import')console.log(JSON.stringify(await reconcileImport(a,b)));
  else if(action==='verify-restored')console.log(JSON.stringify(await verifyRestored(a,b)));
  else if(action==='prepare-upgrade')console.log(JSON.stringify(await prepareSchemaUpgrade(a,b)));
  else if(action==='apply-upgrade')console.log(JSON.stringify(await applySchemaUpgrade(a,b)));
  else if(action==='verify-upgraded')console.log(JSON.stringify(await verifySchemaUpgrade(a,b)));
  else if(action==='prune')console.log(JSON.stringify(await pruneBackups()));
  else throw new Error('Use backup --local|--remote, backup-and-publish, publish/download/resume/verify <backup-id>, restore/reconcile-import/verify-restored/prepare-upgrade/apply-upgrade/verify-upgraded <backup-id> <owned-profile.json>, or prune.');
}catch{
  // Preserve the operation ID/files for inspection. Avoid outputting command
  // bodies, credentials, signed URLs or SQL values from child errors.
  console.error('Operations stage failed. Preserve the existing backup/rehearsal ID and inspect its receipt before retrying.');process.exitCode=1;
}finally{
  if(acquired&&JSON.parse(await readFile(lock,'utf8')).owner===owner)await rm(lock);
}
