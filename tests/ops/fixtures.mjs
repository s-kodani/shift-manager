import{readFile,writeFile,mkdir}from'node:fs/promises';
import{createHash,randomUUID}from'node:crypto';
import path from'node:path';
import{sqlCatalog,RETENTION_MS,save}from'../../scripts/backup-lib.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function fixture(extra='',{fresh=false,body=Buffer.from('{"fictional":true}'),root=path.resolve('.cache/backups')}={}){
  const id=randomUUID(),dir=path.join(root,id);await mkdir(path.join(dir,'objects'),{recursive:true});
  const tables=['input_snapshot','schedule_draft_version','schedule_publication_version','publication_revalidation_source','publication_revalidation_input','publication_revalidation_result'];
  const sql=tables.map(n=>`CREATE TABLE ${n}(object_key TEXT,sha256 TEXT,byte_length INTEGER);`).join('\n')+`\nCREATE TABLE compute_job(state TEXT,result_key TEXT,result_sha256 TEXT,result_bytes INTEGER);CREATE TABLE publication_revalidation_request(state TEXT);INSERT INTO input_snapshot VALUES('fictional/object','${sha(body)}',${body.length});${extra}`;
  await writeFile(path.join(dir,'database.sql'),sql);await writeFile(path.join(dir,'objects',sha(body)+'.json'),body);
  const completedAt=fresh?Date.now():200;const catalog=await sqlCatalog(path.join(dir,'database.sql')),manifest={version:'shift-backup-v1',id,state:'COMPLETE',source:{mode:'local',databaseId:'00000000-0000-0000-0000-000000000000',bucket:'shift-planner-inputs-local'},createdAt:fresh?completedAt-1000:100,completedAt,retentionDays:30,expiresAt:completedAt+RETENTION_MS,sql:{sha256:sha(sql),bytes:Buffer.byteLength(sql)},catalog};await save(path.join(dir,'manifest.json'),manifest);
  return{id,dir,body,manifest,sql};
}
