import {targetFetch} from './deployment-target.mjs';
// Ordinary product HTTP, used before/after the same backup. No solver dispatch.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {boundedJson} from './operator-client.mjs';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export function finalRecoveryProduct({fixtures,ids,base,token,cookies,credentials,fetchImpl=targetFetch,persist=async()=>{}}){
 async function request(route,body,key,{expected=200,text=false,old=false}={}){
  const jar=old?cookies.source[key]:cookies.current[key],r=await fetchImpl(base+route,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,origin:base,'content-type':'application/json',cookie:Object.entries(jar??{}).map(([k,v])=>k+'='+v).join('; ')},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
  assert.equal(r.status,expected,'FINAL_RECOVERY_PRODUCT_STATUS_UNCONFIRMED');
  if(!old)for(const c of r.headers.getSetCookie()){const s=c.split(';')[0],i=s.indexOf('=');cookies.current[key]??={};cookies.current[key][s.slice(0,i)]=s.slice(i+1);}
  await persist();if(!text)return boundedJson(r,16_000_000);
  let size=0;const chunks=[];for await(const c of r.body){size+=c.length;assert(size<=16_000_000);chunks.push(c);}return Buffer.concat(chunks).toString();
 }
 async function capture(){
  const records=[];
  for(const kind of ['single','large']){
   const f=fixtures[kind],admin=kind+'Admin',staff=kind+'Staff',pub=`/api/companies/${f.companyId}/schedules/teams/${f.teamId}/publications`,schedules=pub.slice(0,-'/publications'.length),inputs=`/api/companies/${f.companyId}/inputs/teams/${f.teamId}`,values={};
   for(const [name,route,key,text]of [['publication',pub+'?month='+f.month,admin],['history',pub+'/history?month='+f.month,admin],['csv',pub+'/export?month='+f.month,admin,true],['snapshot',inputs+'/snapshots/'+(kind==='single'?ids.snapshot3:ids.snapshot4),admin],['self',pub+'?month='+f.month,staff],['notices',pub+'/notices',staff],['leave',schedules+'/leave?month='+f.month,admin],['selfLeave',schedules+'/leave?month='+f.month,staff],['leaveNotices',schedules+'/leave/notices',staff],['planning',inputs+'/planning/'+f.month,admin]])values[name]=await request(route,undefined,key,{text});
   const current=values.publication;assert.equal(current.publicationRevision,kind==='single'?3:1);assert.equal(current.publication.assignments.length,f.staffCount*31);assert.equal(values.self.publication.assignments.length,31);assert(values.self.publication.assignments.every(a=>a.staffId===f.staffLogin.staffId));
   values.fixed=await request(pub+'/'+current.publication.publicationId+'/fixed',undefined,admin);
   await request(pub+'/export?month='+f.month,undefined,staff,{expected:403});const other=fixtures[kind==='single'?'large':'single'];await request(`/api/companies/${other.companyId}/schedules/teams/${other.teamId}/publications?month=${f.month}`,undefined,staff,{expected:403});
   if(kind==='single'){assert.equal(values.leave.records.length,1);assert.equal(values.leave.records[0].status,'APPROVED');assert.equal(values.planning.version.payload.events[0].staffIds.length,0);}
   records.push({kind,companyId:f.companyId,publicationRevision:current.publicationRevision,selfRows:31,csvLines:values.csv.trim().split(/\r?\n/).length,hashes:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,hash(v)]))});
  }return records;
 }
 async function guarded(){const a=credentials.singleAdmin;await request('/api/context',undefined,'singleAdmin',{expected:503,old:true});await request('/api/auth/sign-in/email',{email:a.email,password:a.password},'singleAdmin',{expected:503});return {oldSession:503,login:503};}
 async function login(){
  for(const key of ['singleAdmin','singleStaff','largeAdmin','largeStaff']){
   assert(credentials[key]?.email.endsWith('@example.invalid'));assert(credentials[key].password.length>=32);await request('/api/context',undefined,key,{expected:401,old:true});
   await request('/api/auth/sign-in/email',credentials[key],key);await request('/api/context',undefined,key);
  }return {oldSessionsRejected:4,freshLogins:4};
 }
 return {capture,guarded,login,request};
}
