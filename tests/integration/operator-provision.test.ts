import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect} from 'vitest';
import {hashPassword} from 'better-auth/crypto';
import worker from '../../apps/operations/src/operator-worker';
import {inspectProvision} from '../../apps/operations/src/operator-provision';
import {createApp} from '../../apps/api/src/index';
import {operatorProvision,provisionFingerprint} from '../../scripts/operator-contract.mjs';
const base='https://operator.example.invalid',token=crypto.randomUUID()+crypto.randomUUID();
const operatorEnv={DB:env.DB,SOLVER:env.SOLVER,RECOVERY_SECURITY_ID:'',RECOVERY_DATABASE_ID:'00000000-0000-0000-0000-000000000000',OPERATOR_TOKEN:token,OPERATOR_PRINCIPAL:'poc-operator' as const};
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
const request=(path:string,body:unknown,headers:Record<string,string>={})=>new Request(base+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
async function fixture(){const password='Initial-'+crypto.randomUUID();return {password,payload:operatorProvision.parse({operationId:crypto.randomUUID(),userId:crypto.randomUUID(),accountId:crypto.randomUUID(),companyName:'架空運営者発行企業',adminName:'架空初期管理者',adminEmail:`operator-${crypto.randomUUID()}@example.invalid`,passwordHash:await hashPassword(password)})};}
it('guards bootstrap and every unknown route before input or DB; accepts no business or auth API',async()=>{
 for(const envValue of [operatorEnv,{...operatorEnv,OPERATOR_TOKEN:''}])expect((await worker.fetch(new Request(base+'/health'),envValue)).status).toBe(403);
 expect((await worker.fetch(request('/provision','{}',{authorization:'Bearer wrong'}),operatorEnv)).status).toBe(403);
 const health=await worker.fetch(new Request(base+'/health',{headers:{authorization:'Bearer '+token}}),operatorEnv);expect(health.status).toBe(200);expect(health.headers.get('cache-control')).toBe('no-store');
 for(const path of ['/api/auth/sign-up/email','/api/auth/sign-in/email','/api/context','/api/companies','/unknown'])expect((await worker.fetch(request(path,'{}'),operatorEnv)).status).toBe(404);
});
it('rejects browser Origin, malformed fields, media type, invalid UTF-8 and oversized stream before issuance',async()=>{
 const f=await fixture();
 for(const [body,headers,status] of [[f.payload,{origin:base},403],[f.payload,{'content-type':'text/plain'},415],['{',{},400],[{...f.payload,staffData:true},{},400],[{...f.payload,passwordHash:'invalid'},{},400],['x'.repeat(4097),{},413]] as [unknown,Record<string,string>,number][]){const r=await worker.fetch(request('/provision',body,headers),operatorEnv);expect(r.status).toBe(status);expect(r.headers.get('cache-control')).toBe('no-store');}
 const h={authorization:'Bearer '+token,'content-type':'application/json'};
 expect((await worker.fetch(new Request(base+'/provision',{method:'POST',headers:h,body:new Uint8Array([0xff])}),operatorEnv)).status).toBe(400);
 const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(2048));c.enqueue(new Uint8Array(2049));c.close();}});
 expect((await worker.fetch(new Request(base+'/provision',{method:'POST',headers:h,body:stream}),operatorEnv)).status).toBe(413);
 expect(await env.DB.prepare('SELECT 1 FROM company WHERE id=?').bind(f.payload.operationId).first()).toBeNull();
});
it('concurrent identical issuance creates one company, admin, credential and audit; altered payload cannot reissue',async()=>{
 const f=await fixture(),results=await Promise.all(Array.from({length:8},()=>worker.fetch(request('/provision',f.payload),operatorEnv)));
 expect(results.every(r=>r.status===200)).toBe(true);
 const data=await Promise.all(results.map(r=>r.json() as Promise<{replayed:boolean,fingerprint:string}>));expect(data.filter(r=>!r.replayed)).toHaveLength(1);expect(data.every(r=>r.fingerprint===data[0].fingerprint)).toBe(true);
 for(const table of ['company','operator_provision_operation'])expect(await env.DB.prepare(`SELECT count(*) n FROM ${table} WHERE id=?`).bind(f.payload.operationId).first('n')).toBe(1);
 expect(await env.DB.prepare('SELECT count(*) n FROM account WHERE userId=?').bind(f.payload.userId).first('n')).toBe(1);expect(await env.DB.prepare('SELECT count(*) n FROM product_audit WHERE company_id=?').bind(f.payload.operationId).first('n')).toBe(1);
 expect(JSON.stringify(data)).not.toContain(f.password);expect(JSON.stringify(data)).not.toContain(f.payload.passwordHash);expect(JSON.stringify(data)).not.toContain(f.payload.adminEmail);
 expect((await worker.fetch(request('/provision',{...f.payload,companyName:'改変した架空企業'}),operatorEnv)).status).toBe(409);
 const original=await inspectProvision(env.DB,'poc-operator',f.payload.operationId);expect(original.found).toBe(true);expect(await inspectProvision(env.DB,'other-operator',f.payload.operationId)).toEqual({found:false});
 expect(await env.DB.prepare('SELECT name FROM company WHERE id=?').bind(f.payload.operationId).first('name')).toBe(f.payload.companyName);
 // Receipt is historical and cannot expose subsequent business changes.
 await env.DB.prepare('UPDATE company SET revision=4 WHERE id=?').bind(f.payload.operationId).run();expect((await inspectProvision(env.DB,'poc-operator',f.payload.operationId))).toEqual(original);
 await expect(env.DB.prepare('UPDATE operator_provision_operation SET fingerprint=? WHERE id=?').bind('0'.repeat(64),f.payload.operationId).run()).rejects.toThrow('IMMUTABLE_OPERATION');
 expect(await provisionFingerprint({...f.payload})).toBe(data[0].fingerprint);
});
it('audit failure rolls back the complete batch; email collision leaves no company, credential or receipt',async()=>{
 const f=await fixture();await env.DB.exec("CREATE TRIGGER operator_test_audit_failure BEFORE INSERT ON product_audit WHEN NEW.kind='operator_provision_company' BEGIN SELECT RAISE(ABORT,'fictional private failure'); END;");
 try{const r=await worker.fetch(request('/provision',f.payload),operatorEnv);expect(r.status).toBe(500);expect(await r.json()).toEqual({error:'PROVISION_UNAVAILABLE'});}finally{await env.DB.exec('DROP TRIGGER operator_test_audit_failure');}
 for(const [table,key,value] of [['company','id',f.payload.operationId],['user','id',f.payload.userId],['account','userId',f.payload.userId],['access_state','user_id',f.payload.userId],['operator_provision_operation','id',f.payload.operationId]] as const)expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).bind(value).first()).toBeNull();
 expect((await worker.fetch(request('/provision',f.payload),operatorEnv)).status).toBe(200);
 const second=await fixture();second.payload.adminEmail=f.payload.adminEmail;expect((await worker.fetch(request('/provision',second.payload),operatorEnv)).status).toBe(409);
 expect(await env.DB.prepare('SELECT 1 FROM company WHERE id=?').bind(second.payload.operationId).first()).toBeNull();expect(await env.DB.prepare('SELECT 1 FROM user WHERE id=?').bind(second.payload.userId).first()).toBeNull();
});
it('initial native sign-in is forced to change password before business access, then company setup succeeds',async()=>{
 const f=await fixture();expect((await worker.fetch(request('/provision',f.payload),operatorEnv)).status).toBe(200);
 const app=createApp(),appBase=env.AUTH_BASE_URL,headers={origin:appBase,'content-type':'application/json'};
 const signin=await app.request(appBase+'/api/auth/sign-in/email',{method:'POST',headers,body:JSON.stringify({email:f.payload.adminEmail,password:f.password})},env);expect(signin.status).toBe(200);let cookie=signin.headers.get('set-cookie')!.split(';')[0];
 expect((await app.request(appBase+'/api/context',{headers:{cookie}},env)).status).toBe(403);
 const changed=await app.request(appBase+'/api/password',{method:'POST',headers:{...headers,cookie},body:JSON.stringify({currentPassword:f.password,newPassword:'Changed-'+crypto.randomUUID()})},env);expect(changed.status).toBe(200);
 expect((await app.request(appBase+'/api/context',{headers:{cookie}},env)).status).toBe(401);
 cookie=changed.headers.get('set-cookie')!.split(';')[0];
 const context=await app.request(appBase+'/api/context',{headers:{cookie}},env);expect(context.status).toBe(200);expect(await context.json()).toMatchObject({companies:[{id:f.payload.operationId,role:'company_admin',teams:[]}]});
 expect((await app.request(appBase+`/api/companies/${f.payload.operationId}/teams`,{method:'POST',headers:{...headers,cookie},body:JSON.stringify({operationId:crypto.randomUUID(),expectedRevision:0,name:'架空新規チーム'})},env)).status).toBe(200);
});
