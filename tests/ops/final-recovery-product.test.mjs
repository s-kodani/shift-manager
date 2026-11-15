import test from 'node:test';
import assert from 'node:assert/strict';
import {finalRecoveryProduct} from '../../scripts/final-recovery-product.mjs';
import {fixtures,ids,keys,server,credentials,jar} from './fixtures/final-recovery-product.mjs';
test('same ordinary product records survive recovery; four old sessions refuse and fresh logins preserve self/company/CSV boundaries',async()=>{
 const s=server(),cookies={source:jar(),current:jar()},client=finalRecoveryProduct({fixtures,ids,credentials,cookies,base:'https://fictional.example.invalid',token:'fictional-poc',fetchImpl:s.fetch});const before=await client.capture();assert.equal(s.calls.filter(c=>c.method==='POST').length,0);assert(before.every(r=>Object.keys(r.hashes).length===11));s.freeze(true);assert.deepEqual(await client.guarded(),{oldSession:503,login:503});s.freeze(false);s.restore();assert.deepEqual(await client.login(),{oldSessionsRejected:4,freshLogins:4});assert.deepEqual(await client.capture(),before);assert(s.calls.every(c=>c.redirect==='error'));s.alter();assert.notDeepEqual(await client.capture(),before);
});
test('unexpected restored guard/login status stops before credential dispatch',async()=>{
 let posts=0;const client=finalRecoveryProduct({fixtures,ids,credentials,cookies:{source:jar(),current:jar()},base:'https://fictional.example.invalid',token:'fictional-poc',fetchImpl:async(_,o)=>{if(o.method==='POST')posts++;return Response.json({unexpected:true});}});await assert.rejects(client.login(),/FINAL_RECOVERY_PRODUCT_STATUS_UNCONFIRMED/);assert.equal(posts,0);
});
