import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {createApp} from '../../apps/api/src/index';
import {inputFixture} from '../../apps/api/src/input-probes';
import {verifyFinalCsv} from '../../scripts/final-csv-check.mjs';

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
it('final CSV sequence uses actual auth and D1/R2, records before one apply and never creates a calculation',async()=>{
 const f=await inputFixture(env.DB,env.INPUTS),app=createApp(),jars:{admin:string;staff:string}={admin:'',staff:''};
 const calls:{route:string;body?:object}[]=[],events:object[]=[];
 async function raw(route:string,body?:object,staff=false){
  const r=await app.request(env.AUTH_BASE_URL+route,{method:body===undefined?'GET':'POST',headers:{origin:env.AUTH_BASE_URL,'content-type':'application/json',cookie:jars[staff?'staff':'admin']},body:body===undefined?undefined:JSON.stringify(body)},env);
  const cookie=r.headers.get('set-cookie');if(cookie)jars[staff?'staff':'admin']=cookie.split(';')[0];return r;
 }
 const staffEmail=await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(f.staffUser).first<string>('email');
 for(const [staff,email,password] of [[false,f.email,f.company.initialPassword],[true,staffEmail,f.staff.initialPassword]] as const){
  expect((await raw('/api/auth/sign-in/email',{email,password},staff)).status).toBe(200);
  if(staff)expect((await raw('/api/password',{currentPassword:password,newPassword:crypto.randomUUID()+crypto.randomUUID()},true)).status).toBe(200);
 }
 const id=crypto.randomUUID();
 const result=await verifyFinalCsv({fixture:{companyId:f.company.companyId,teamId:f.team,month:'2026-10'},operationId:id,
  request:async(route,body,options={})=>{
   calls.push({route,body});if(route.endsWith('/apply'))expect(events.length).toBe(1);
   const r=await raw(route,body,options.staff);expect(r.status).toBe(options.expected??200);return r.json();
  },record:async value=>{events.push(value);}});
 expect(result).toMatchObject({month:'2026-11',validRows:2,rejectedRows:1,directZero:0,unsetDirect:null,scaledCalculated:[200,100],applyPosts:1,receiptInspected:true,currentMonthVersionUnchanged:true});
 expect(calls.filter(c=>c.route.endsWith('/apply')).length).toBe(1);
 expect(await env.DB.prepare('SELECT count(*) n FROM compute_job WHERE company_id=?').bind(f.company.companyId).first<number>('n')).toBe(0);
 expect(await env.DB.prepare('SELECT count(*) n FROM demand_csv_receipt WHERE company_id=? AND operation_id=?').bind(f.company.companyId,id).first<number>('n')).toBe(1);
});
