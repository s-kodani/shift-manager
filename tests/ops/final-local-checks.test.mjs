import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {assertLocalCheckReport,verifyLocalCheckFiles,runLocalChecks} from '../../scripts/final-local-checks.mjs';
const commit='1'.repeat(40),digest='2'.repeat(64),sha=b=>createHash('sha256').update(b).digest('hex');
import {passedLocalReport} from './fixtures/final-local-report.mjs';
async function fixture(work){const root=path.resolve('.cache/final-local-checks',randomUUID());await mkdir(root,{recursive:true,mode:0o700});try{return await work(root);}finally{await rm(root,{recursive:true});}}
test('local alternative cannot pass with CI success claims, missing/failed checks, timeouts, changed commit, skipped image scan or an owned tag left behind',()=>{
 const v=passedLocalReport();assert.doesNotThrow(()=>assertLocalCheckReport(v,commit));
 for(const edit of [v=>v.state='RUNNING',v=>v.ci='success',v=>v.decision='unapproved',v=>v.sourceCommit='3'.repeat(40),v=>v.sourceUnchanged=false,v=>v.steps.pop(),v=>v.steps[0].exitCode=1,v=>v.steps[0].interrupted=true,v=>v.steps[0].signal='SIGTERM',v=>v.steps[0].args=['run','deploy:poc'],v=>v.steps[0].log='../external.log',v=>v.security.pop(),v=>v.security[0].exitCode=1,v=>v.securityImage='mutable-tag',v=>v.ownedImageTagRemoved=false]){const c=structuredClone(v);edit(c);assert.throws(()=>assertLocalCheckReport(c,commit));}
});
test('local receipt requires actual bound logs and matching report digest, not just a PASSED field',async()=>fixture(async root=>{
 const v=passedLocalReport();for(const step of v.steps)await writeFile(root+'/'+step.log,step.name,{mode:0o600});
 const bytes=JSON.stringify(v);await writeFile(root+'/report.json',bytes,{mode:0o600});
 assert.equal((await verifyLocalCheckFiles(root,commit,{expectedSha256:sha(bytes)})).value.state,'PASSED');
 await assert.rejects(verifyLocalCheckFiles(root,commit,{expectedSha256:digest}));
 await writeFile(root+'/worker.log','changed');await assert.rejects(verifyLocalCheckFiles(root,commit),/FINAL_LOCAL_CHECKS_LOG_CHANGED/);
}));
test('failed first command stops the fixed batch and persists failure without attempting later checks or declaring CI success',async()=>{
 const root=path.resolve('.cache/final-local-checks',randomUUID());let calls=0;
 try{const r=await runLocalChecks(root,{inspect:async()=>({sourceCommit:commit,sourceSha256:digest}),execute:async(command,args,{log})=>{calls++;assert.equal(command,'npm');assert.deepEqual(args,['run','check']);await writeFile(log,'synthetic command failure',{mode:0o600});return {exitCode:1,signal:null,interrupted:false};},environment:{NATIVE_HTTP_COMPUTE:'1',SECURITY_IMAGE:'unrelated-tag'}});
 assert.equal(calls,1);assert.equal(r.state,'FAILED');assert.equal(r.ci,'HELD_NOT_SUCCESS');assert.equal(JSON.parse(await readFile(root+'/report.json')).state,'FAILED');
 }finally{await rm(root,{recursive:true});}
});
