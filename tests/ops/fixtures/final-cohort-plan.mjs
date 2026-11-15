import {readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function finalCohortFixture(work){
 const id=randomUUID(),root=path.resolve('.cache/final-cloudflare',id),artifact=path.resolve('artifacts/final-cloudflare',id),commit='1'.repeat(40);
 // Commands/builds are synthetic in this fixture. Cover real Worker and
 // optimizer files, nested modes, and every migration without repeatedly
 // copying unrelated UI assets and historical evidence. Production keeps
 // enumerating and verifying the complete tracked source tree.
 const files=[
  'README.md','infra/wrangler.jsonc','infra/operator-provision.jsonc',
  'docs/mvp/cloudflare-final-cases.json','apps/api/src/poc-worker.ts',
  'apps/operations/src/operator-worker.ts','services/optimizer/Dockerfile',
  'services/optimizer/optimizer/__init__.py','services/optimizer/optimizer/server.py',
  ...(await readdir('infra/migrations')).filter(n=>n.endsWith('.sql')).map(n=>'infra/migrations/'+n),
 ].sort(),pairs=await Promise.all(files.map(async file=>[file,sha(await readFile(file))])),source={sourceCommit:commit,sourceSha256:sha(JSON.stringify(pairs))};
 const release={state:'DRAFT',candidateCommit:commit,sourceInputSha256:sha('{}'),configSha256:sha(await readFile('infra/wrangler.jsonc')),casesSha256:sha(await readFile('docs/mvp/cloudflare-final-cases.json')),limits:JSON.parse(await readFile('docs/mvp/cloudflare-final-cases.json')).limits};
 await mkdir(root,{recursive:true,mode:0o700});await mkdir(artifact,{recursive:true,mode:0o700});
 const write=(file,value)=>writeFile(file,JSON.stringify(value),{mode:0o600});await write(root+'/release.json',release);await write(root+'/runtime.json',{id,root,artifact,mode:'cloudflare',base:'https://shift-manager-example.example.invalid'});await writeFile(artifact+'/source.json','{}',{mode:0o600});
 const assets=artifact+'/test-assets';await mkdir(assets,{mode:0o700});await mkdir(assets+'/assets',{mode:0o700});await writeFile(assets+'/index.html','fictional');await writeFile(assets+'/assets/app.js','fictional');
 const options={inspectSource:async()=>source,listSource:()=>files,build:async()=> 'controlled build; no actual deployment',assetsDirectory:assets};
 try{return await work({root,artifact,source,options,release,write});}finally{await rm(root,{recursive:true});await rm(artifact,{recursive:true});}
}
