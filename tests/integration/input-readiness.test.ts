import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { inputFixture, probePolicy, probeConfig } from "../../apps/api/src/input-probes";
import { createApp } from "../../apps/api/src/index";
import { createStaff, createTeam, grantTeamAdmin, provisionCompany } from "../../apps/api/src/product";
import { readInputReadiness } from "../../apps/api/src/input-readiness";
import { changeStaffStatus } from "../../apps/api/src/staff-lifecycle";
import { saveHistory } from "../../apps/api/src/work-history";
import { readinessResponse } from "../../apps/api/src/readiness-contract";
import type { InputDatabase } from "../../apps/api/src/input-versions";

let f: Awaited<ReturnType<typeof inputFixture>>;
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { f = await inputFixture(env.DB); });
const revision = async () => (await env.DB.prepare("SELECT revision FROM company WHERE id=?").bind(f.company.companyId).first<number>("revision"))!;
const read = (user = f.company.userId, db: InputDatabase = env.DB) => readInputReadiness({ DB: db, INPUTS: env.INPUTS }, f.company.companyId, f.team, user, "2026-10");
const item = (data: Awaited<ReturnType<typeof read>>, id: string) => data.items.find(value => value.id === id)!;

it("empty setup returns every missing section rather than failing at the first prerequisite", async () => {
  const c = await provisionCompany(env.DB, { name: "架空空企業", adminName: "架空管理者", adminEmail: `${crypto.randomUUID()}@example.invalid` });
  await env.DB.prepare("UPDATE access_state SET must_change_password=0 WHERE user_id=?").bind(c.userId).run();
  const team = (await createTeam(env.DB,c.companyId,c.userId,{operationId:crypto.randomUUID(),expectedRevision:0,name:"架空空チーム"})).teamId;
  const data = await readInputReadiness(env,c.companyId,team,c.userId,"2026-10");
  expect(data.canCompute).toBe(false);
  for (const id of ["calendar","company_policy","team_config","staff","planning"]) expect(item(data,id).status).toBe("missing");
  expect(item(data,"contracts").status).toBe("unconfirmed");
  expect(item(data,"consistency").status).toBe("unconfirmed");
  expect(item(data,"history").required).toBe(false);
});
it("complete input is calculable with missing history; confirmed holidays complete history without changing the remaining conditions",async()=>{
  const before=await revision(),data=await read();
  expect(data).toMatchObject({canCompute:true,inputRevision:before,draftRevision:0});
  expect(item(data,"history")).toMatchObject({status:"missing",required:false,count:6});
  expect(item(data,"consistency").status).toBe("complete");
  await saveHistory(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:before,month:"2026-10",records:Array.from({length:6},(_,i)=>({staffId:f.staff.staffId,date:`2026-09-${30-i}`,workedMinutes:0,evidence:"架空の確認済み休日"}))});
  expect(item(await read(),"history")).toMatchObject({status:"complete",count:0});
});
it("empty saved demand and absence of staff-month submissions are not blockers",async()=>{
  await f.save("planning",{demand:[],events:[],roleRequirements:[]});
  await f.save("staff_month",{unavailable:[],preferences:[]});
  // Use another month with no monthly submissions and an explicitly saved plan.
  await f.save("planning",{demand:[],events:[],roleRequirements:[]},undefined,"2026-11");
  const data=await readInputReadiness(env,f.company.companyId,f.team,f.company.userId,"2026-11");
  expect(data.canCompute).toBe(true);expect(item(data,"planning")).toMatchObject({status:"warning",count:0,code:"DEMAND_COVERAGE_MISSING"});
  expect(item(data,"planning").demandCoverage).toMatchObject({expectedSlots:720,missingSlots:720});
  expect(item(data,"preferences").message).toContain("0名");expect(item(data,"preferences").required).toBe(false);
});
it("requires every general task slot in the company range, counts explicit zero and calculated demand, and warns on a single missing slot",async()=>{
  const demand: typeof f.plan.demand=Array.from({length:31},(_,day)=>Array.from({length:24},(_,slot)=>({
    date:`2026-10-${String(day+1).padStart(2,'0')}`,start:480+slot*30,end:510+slot*30,
    taskId:'phone',direct:0,calculated:2,
  }))).flat();
  // Dedicated supervision has no demand; non-business rows cannot replace a gap.
  await f.save("planning",{demand,events:[],roleRequirements:[]});
  let data=await read();
  expect(data.canCompute).toBe(true);
  expect(item(data,"planning")).toMatchObject({status:"complete",demandCoverage:{expectedSlots:744,missingSlots:0}});
  const missing=demand.splice(300,1)[0]!;
  demand[0]={...demand[0]!,direct:null,calculated:0};
  await f.save("planning",{demand,events:[],roleRequirements:[]});
  data=await read();
  expect(data.canCompute).toBe(true);
  expect(item(data,"planning")).toMatchObject({status:"warning",demandCoverage:{missingSlots:1,examples:[{
    date:missing.date,start:missing.start,end:missing.end,taskId:missing.taskId,
  }]}});
  expect(item(data,"consistency").status).toBe("complete");
  expect(item(data,"history").status).toBe("missing");
});
it("uses the company weekday and time range effective for the selected month",async()=>{
  await f.save("company_policy",{...probePolicy,contract:{weekdays:[0],start:600,end:660}},undefined,"2026-11");
  await f.save("planning",{demand:[],events:[],roleRequirements:[]},undefined,"2026-11");
  expect(item(await read(),"planning").demandCoverage?.expectedSlots).toBe(744);
  const next=await readInputReadiness(env,f.company.companyId,f.team,f.company.userId,"2026-11");
  expect(item(next,"planning")).toMatchObject({status:"warning",demandCoverage:{expectedSlots:10,missingSlots:10,
    examples:[{date:"2026-11-01",start:600,end:630,taskId:"phone"},{date:"2026-11-01",start:630,end:660,taskId:"phone"},
      {date:"2026-11-08",start:600,end:630,taskId:"phone"},{date:"2026-11-08",start:630,end:660,taskId:"phone"},
      {date:"2026-11-15",start:600,end:630,taskId:"phone"},{date:"2026-11-15",start:630,end:660,taskId:"phone"},
      {date:"2026-11-22",start:600,end:630,taskId:"phone"},{date:"2026-11-22",start:630,end:660,taskId:"phone"},
      {date:"2026-11-29",start:600,end:630,taskId:"phone"},{date:"2026-11-29",start:630,end:660,taskId:"phone"}]}});
});
it("all active staff need a contract; deactivation and deletion remove only unpublished people from readiness",async()=>{
  const extra=await createStaff(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),name:"架空追加スタッフ",staffNumber:"0002",email:`${crypto.randomUUID()}@example.invalid`});
  let data=await read();expect(data.canCompute).toBe(false);expect(item(data,"contracts")).toMatchObject({status:"missing",count:1});
  for(const status of ["inactive","deleted"] as const){
    await changeStaffStatus(env.DB,f.company.companyId,f.team,extra.staffId,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),status});
    data=await read();expect(data.canCompute).toBe(true);expect(item(data,"staff").count).toBe(1);
  }
  await changeStaffStatus(env.DB,f.company.companyId,f.team,f.staff.staffId,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),status:"inactive"});
  data=await read();expect(data.canCompute).toBe(false);expect(item(data,"staff")).toMatchObject({status:"missing",count:0});
});
it("new common conditions expose a known contract contradiction with an actionable section",async()=>{
  await f.save("company_policy",{...probePolicy,contract:{...probePolicy.contract,weekdays:[0]}});
  const data=await read();expect(data.canCompute).toBe(false);expect(item(data,"contracts")).toMatchObject({status:"invalid",count:1,section:"staff",code:"CONTRADICTORY_CONTRACT"});
});
it("cross-policy monthly bounds and event attendance are checked using the existing compiler",async()=>{
  await f.save("company_policy",{...probePolicy,rule:{...probePolicy.rule,monthlyMax:100}});
  let data=await read();expect(data.canCompute).toBe(false);expect(item(data,"consistency")).toMatchObject({status:"invalid",code:"CONTRADICTORY_RULE",section:"staff"});
  await f.save("company_policy",probePolicy);
  await f.save("team_config",{...probeConfig,patterns:[{...probeConfig.patterns[0],start:720,end:1020}]});
  data=await read();expect(data.canCompute).toBe(false);expect(item(data,"consistency")).toMatchObject({status:"invalid",code:"EVENT_ATTENDANCE_CONFLICT",section:"demand"});
  expect(item(data,"history")).toMatchObject({status:"missing",count:6});
});
it("readiness performs only reads, has no snapshots or job dispatch and never persists auxiliary metadata",async()=>{
  const calls:string[]=[];
  const prepare=(sql:string)=>{calls.push(sql);if(!/^\s*(SELECT|WITH)\b/i.test(sql))throw Error("WRITE_ATTEMPT");return env.DB.prepare(sql);};
  const db:InputDatabase={prepare,batch:env.DB.batch.bind(env.DB)};
  const bucket=new Proxy(env.INPUTS,{get(target,key){if(["put","delete"].includes(String(key)))throw Error("BUCKET_WRITE_ATTEMPT");const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;}});
  const before=await revision();expect((await readInputReadiness({DB:db,INPUTS:bucket},f.company.companyId,f.team,f.company.userId,"2026-10")).canCompute).toBe(true);
  expect(await revision()).toBe(before);expect(calls.length).toBeGreaterThan(0);
  expect(await env.DB.prepare("SELECT count(*) n FROM input_snapshot WHERE company_id=?").bind(f.company.companyId).first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) n FROM compute_job WHERE company_id=?").bind(f.company.companyId).first("n")).toBe(0);
});
it("permissions cover company/team boundaries, staff and live disabling; same-team admins can read status without company settings payloads",async()=>{
  await expect(read(f.staffUser)).rejects.toThrow("FORBIDDEN");
  await env.DB.prepare("UPDATE access_state SET must_change_password=0 WHERE user_id=?").bind(f.staffUser).run();
  await grantTeamAdmin(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),userId:f.staffUser});
  const data=await read(f.staffUser);expect(data.canCompute).toBe(true);expect(JSON.stringify(data)).not.toContain("monthlyMax");
  await expect(readInputReadiness(env,f.company.companyId,crypto.randomUUID(),f.company.userId,"2026-10")).rejects.toThrow("FORBIDDEN");
  const other=await inputFixture(env.DB);await expect(read(other.company.userId)).rejects.toThrow("FORBIDDEN");
  await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?").bind(f.staffUser).run();
  await expect(read(f.staffUser)).rejects.toThrow("FORBIDDEN");
});
it.each(["revision","permission"])("a concurrent %s change rejects a mixed readiness report",async kind=>{
  let mutated=false;
  const db:InputDatabase={prepare:env.DB.prepare.bind(env.DB),batch:async<T>(statements:D1PreparedStatement[])=>{
    const result=await env.DB.batch<T>(statements);
    if(!mutated){mutated=true;
      if(kind==="revision")await env.DB.prepare("UPDATE company SET revision=revision+1 WHERE id=?").bind(f.company.companyId).run();
      else if(kind==="permission")await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?").bind(f.company.userId).run();
    }return result;
  }};
  await expect(read(f.company.userId,db)).rejects.toThrow(kind==="permission"?"FORBIDDEN":"VERSION_CONFLICT");
});
it("HTTP endpoint is no-store, requires a session and validates the target month",async()=>{
  const app=createApp(),base=env.AUTH_BASE_URL,path=`/api/companies/${f.company.companyId}/inputs/teams/${f.team}/readiness/`;
  expect((await app.request(base+path+"2026-10",{},env)).status).toBe(401);
  const login=await app.request(base+"/api/auth/sign-in/email",{method:"POST",headers:{origin:base,"content-type":"application/json"},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env);
  const cookie=login.headers.get("set-cookie")!.split(";")[0];
  const response=await app.request(base+path+"2026-10",{headers:{cookie}},env);
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");expect(readinessResponse.parse(await response.json()).canCompute).toBe(true);
  expect((await app.request(base+path+"2026-13",{headers:{cookie}},env)).status).toBe(400);
});
