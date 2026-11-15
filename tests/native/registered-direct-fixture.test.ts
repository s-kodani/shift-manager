import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {registeredOperationalFixture,disableRegisteredFixture} from '../fixtures/registered-operational';
import type {OptimizerInput,OptimizerAssignments} from '../../packages/contracts/optimizer-input.generated';
import local from '../../apps/api/src/local-ui-worker';

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
it('the legacy direct registration fixture preserves ten people and required history when HTTP authentication is not requested',async()=>{
 const binding=env as unknown as {LARGE_CHECKER_FIXTURE:Fetcher};
 const all=await(await binding.LARGE_CHECKER_FIXTURE.fetch('http://large-fixture.local/')).json() as {input:OptimizerInput;assignments:OptimizerAssignments};
 const input={...all.input,staff:all.input.staff.slice(0,10)},ids=new Set(input.staff.map(s=>s.id));
 input.events=input.events.map(e=>({...e,staffIds:e.staffIds.filter(id=>ids.has(id))})).filter(e=>e.staffIds.length>0);
 input.history=input.history.filter(h=>ids.has(h.staffId));input.locks=input.locks.filter(l=>ids.has(l.staffId));input.exceptions=input.exceptions.filter(e=>ids.has(e.staffId));
 const f=await registeredOperationalFixture(env,{input,assignments:all.assignments.filter(a=>ids.has(a.staffId))});
 try {
  expect(f.frozen.input.staff).toHaveLength(10);expect(f.frozen.input.history).toHaveLength(50);expect(f.frozen.input.locks).toEqual([]);
  const inverse=new Map([...f.staffIds].map(([old,id])=>[id,old]));
  const normalized=(staff:OptimizerInput['staff'])=>staff.map(s=>({...s,id:inverse.get(s.id)??s.id,rules:s.rules.map(({id,...r})=>r)})).sort((a,b)=>a.id.localeCompare(b.id));
  expect(normalized(f.frozen.input.staff)).toEqual(normalized(input.staff));
  expect(f.frozen.input.demand).toEqual(input.demand);expect(f.frozen.input.roleRequirements).toEqual(input.roleRequirements);
  expect(await env.DB.prepare('SELECT count(*) n FROM work_history_version WHERE company_id=? AND team_id=?').bind(f.companyId,f.team).first<number>('n')).toBe(70);
  expect(await env.DB.prepare('SELECT must_change_password FROM access_state WHERE user_id=?').bind(f.userId).first<number>('must_change_password')).toBe(0);
 }finally{await disableRegisteredFixture(env,f.companyId);}
});
it('the loopback browser fixture restores both first-change gates and owns cleanup of credentials after direct setup',async()=>{
 const binding=env as unknown as {LARGE_CHECKER_FIXTURE:Fetcher};
 const all=await(await binding.LARGE_CHECKER_FIXTURE.fetch('http://large-fixture.local/')).json() as {input:OptimizerInput;assignments:OptimizerAssignments};
 const input={...all.input,staff:all.input.staff.slice(0,10),jobId:'fictional-operational-10-30-v1'},ids=new Set(input.staff.map(s=>s.id));
 input.events=input.events.map(e=>({...e,staffIds:e.staffIds.filter(id=>ids.has(id))})).filter(e=>e.staffIds.length>0);
 input.history=input.history.filter(h=>ids.has(h.staffId));input.locks=input.locks.filter(l=>ids.has(l.staffId));input.exceptions=input.exceptions.filter(e=>ids.has(e.staffId));
 const source={input,assignments:all.assignments.filter(a=>ids.has(a.staffId))};
 const bindings={...env,ENVIRONMENT:'local'},headers={authorization:'Bearer '+env.POC_TOKEN,'content-type':'application/json'};
 const response=await local.fetch(new Request('http://localhost:8787/__local/operational-fixture',{method:'POST',headers,body:JSON.stringify(source)}),bindings,{} as ExecutionContext);
 expect(response.status).toBe(200);
 const f=await response.json() as {companyId:string;fixtureId:string;staffLogin:{staffId:string;initialPassword:string};password:string;staffCount:number;requiredHistoryCount:number};
 try {
  expect(f.staffCount).toBe(10);expect(f.requiredHistoryCount).toBe(50);
  expect(typeof f.password==='string'&&f.password.length>=16).toBe(true);
  expect(typeof f.staffLogin.initialPassword==='string'&&f.staffLogin.initialPassword.length>=16).toBe(true);
  const admin=await env.DB.prepare('SELECT user_id FROM company_admin WHERE company_id=?').bind(f.companyId).first<string>('user_id');
  const staff=await env.DB.prepare('SELECT user_id FROM staff WHERE id=?').bind(f.staffLogin.staffId).first<string>('user_id');
  for(const id of [admin,staff])expect(await env.DB.prepare('SELECT must_change_password FROM access_state WHERE user_id=?').bind(id).first<number>('must_change_password')).toBe(1);
 } finally {
  const cleaned=await local.fetch(new Request('http://localhost:8787/__local/cleanup',{method:'POST',headers,body:JSON.stringify({fixtureId:f.fixtureId})}),bindings,{} as ExecutionContext);
  expect(cleaned.status).toBe(200);
  const users='SELECT user_id FROM company_admin WHERE company_id=? UNION SELECT user_id FROM staff WHERE company_id=?';
  expect(await env.DB.prepare(`SELECT count(*) n FROM account WHERE password IS NOT NULL AND userId IN (${users})`).bind(f.companyId,f.companyId).first<number>('n')).toBe(0);
 }
});
