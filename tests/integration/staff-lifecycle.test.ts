import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { inputFixture } from "../../apps/api/src/input-probes";
import { changeStaffStatus } from "../../apps/api/src/staff-lifecycle";
import { createApp } from "../../apps/api/src/index";
import { createStaff, grantTeamAdmin } from "../../apps/api/src/product";
import { compileInput, loadSources } from "../../apps/api/src/input-snapshots";

let f: Awaited<ReturnType<typeof inputFixture>>;
const app = createApp();
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => { f = await inputFixture(env.DB); });
const revision = async () => (await env.DB.prepare("SELECT revision FROM company WHERE id=?").bind(f.company.companyId).first<number>("revision"))!;
const command = async (status: "active" | "inactive" | "deleted") => ({ operationId: crypto.randomUUID(), expectedRevision: await revision(), status });
const change = (c: Awaited<ReturnType<typeof command>>, user = f.company.userId, db: Pick<D1Database,"prepare"|"batch"> = env.DB) =>
  changeStaffStatus(db,f.company.companyId,f.team,f.staff.staffId,user,c);
const state = () => env.DB.prepare("SELECT s.status,a.enabled,u.banned,a.must_change_password FROM staff s JOIN access_state a ON a.user_id=s.user_id JOIN user u ON u.id=s.user_id WHERE s.company_id=? AND s.id=?")
  .bind(f.company.companyId,f.staff.staffId).first();
async function cookie(email: string, password: string) {
  const r = await app.request(env.AUTH_BASE_URL+"/api/auth/sign-in/email", { method:"POST",headers:{ origin:env.AUTH_BASE_URL,"content-type":"application/json" },body:JSON.stringify({email,password}) },env);
  expect(r.status).toBe(200); return r.headers.get("set-cookie")!.split(";")[0];
}
const path = () => `/api/companies/${f.company.companyId}/teams/${f.team}/staff`;
const request = (url: string, session: string, body?: object, origin = env.AUTH_BASE_URL) => app.request(env.AUTH_BASE_URL+url,{
  method:body?"POST":"GET",headers:{cookie:session,origin,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})
},env);

it("deactivation stops existing sessions and sign-in, preserves inputs; reactivation preserves password-change requirement; deletion is terminal", async () => {
  await env.DB.prepare("UPDATE access_state SET must_change_password=0 WHERE user_id=?").bind(f.staffUser).run();
  const email=(await env.DB.prepare("SELECT email FROM user WHERE id=?").bind(f.staffUser).first<string>("email"))!;
  const member=await cookie(email,f.staff.initialPassword!), admin=await cookie(f.email,f.company.initialPassword);
  const before=await env.DB.prepare("SELECT payload FROM work_input_version WHERE company_id=? AND staff_id=? ORDER BY revision").bind(f.company.companyId,f.staff.staffId).all();
  const c=await command("inactive");
  expect((await request(path()+`/${f.staff.staffId}/status`,admin,c)).status).toBe(200);
  expect(await state()).toMatchObject({status:"inactive",enabled:0,banned:1,must_change_password:0});
  expect((await request("/api/access",member)).status).toBe(401);
  const login=await app.request(env.AUTH_BASE_URL+"/api/auth/sign-in/email",{method:"POST",headers:{origin:env.AUTH_BASE_URL,"content-type":"application/json"},body:JSON.stringify({email,password:f.staff.initialPassword})},env);
  expect(login.status).toBe(403);
  expect(await (await request(path(),admin)).json()).toMatchObject({staff:[{id:f.staff.staffId,status:"inactive",can_manage_status:1}]});
  expect(await change(await command("active"))).toMatchObject({replayed:false});
  expect(await state()).toMatchObject({status:"active",enabled:1,banned:0,must_change_password:0});
  await cookie(email,f.staff.initialPassword!);
  expect(await change(c)).toMatchObject({replayed:true});
  expect(await state()).toMatchObject({status:"active"});
  const deletion=await command("deleted"); await change(deletion);
  expect(await change(deletion)).toMatchObject({replayed:true});
  expect(await (await request(path(),admin)).json()).toEqual({staff:[]});
  await expect(change(await command("active"))).rejects.toThrow("INVALID_REFERENCE");
  expect((await env.DB.prepare("SELECT payload FROM work_input_version WHERE company_id=? AND staff_id=? ORDER BY revision").bind(f.company.companyId,f.staff.staffId).all()).results).toEqual(before.results);
  await expect(createStaff(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),name:"別の架空スタッフ",staffNumber:"0001",email:`${crypto.randomUUID()}@example.invalid`})).rejects.toThrow("DUPLICATE_RESOURCE");
});
it("same operation commits once, rejects altered payload and stale revision", async () => {
  const c=await command("inactive");
  const results=await Promise.all([change(c),change(c)]);
  expect(results.filter(r=>r.replayed)).toHaveLength(1);
  expect(await revision()).toBe(c.expectedRevision+1);
  await expect(change({...c,status:"active"})).rejects.toThrow("OPERATION_ID_CONFLICT");
  await expect(change({...c,operationId:crypto.randomUUID(),status:"deleted"})).rejects.toThrow("VERSION_CONFLICT");
  await change(await command("active"));
  expect(await state()).toMatchObject({must_change_password:1});
});
it.each(["audit","status","access","banned","revision"])("silent %s omission rolls back all changes and permits identical retry",async fault=>{
  const c=await command("inactive");
  const target=fault==="audit"?"BEFORE INSERT ON product_audit WHEN NEW.kind='staff:inactive'":fault==="status"?"BEFORE UPDATE ON staff":fault==="access"?"BEFORE UPDATE ON access_state":fault==="banned"?"BEFORE UPDATE ON user":"BEFORE UPDATE ON company";
  await env.DB.prepare(`CREATE TRIGGER lifecycle_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
  try {
    await expect(change(c)).rejects.toThrow();
    expect(await state()).toMatchObject({status:"active",enabled:1,banned:0});
    expect(await revision()).toBe(c.expectedRevision);
    for(const table of ["staff_lifecycle_operation","product_audit"])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
  } finally { await env.DB.prepare("DROP TRIGGER lifecycle_omission").run(); }
  expect(await change(c)).toMatchObject({replayed:false});
});
it("staff and foreign managers cannot mutate; same-team manager can, but cannot stop oneself or company admins",async()=>{
  await env.DB.prepare("UPDATE access_state SET must_change_password=0 WHERE user_id=?").bind(f.staffUser).run();
  await expect(change(await command("inactive"),f.staffUser)).rejects.toThrow("FORBIDDEN");
  await grantTeamAdmin(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),userId:f.staffUser});
  await expect(change(await command("inactive"),f.staffUser)).rejects.toThrow("STAFF_ACCOUNT_PROTECTED");
  const other=await inputFixture(env.DB);
  await expect(change(await command("inactive"),other.company.userId)).rejects.toThrow("FORBIDDEN");
  await expect(changeStaffStatus(env.DB,f.company.companyId,other.team,f.staff.staffId,f.company.userId,await command("inactive"))).rejects.toThrow("FORBIDDEN");
  const second=await createStaff(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),name:"架空追加スタッフ",staffNumber:"0002",email:`${crypto.randomUUID()}@example.invalid`});
  await changeStaffStatus(env.DB,f.company.companyId,f.team,second.staffId,f.staffUser,await command("inactive"));
  await env.DB.prepare("INSERT INTO company_admin(company_id,user_id) VALUES (?,?)").bind(f.company.companyId,f.staffUser).run();
  await expect(change(await command("deleted"))).rejects.toThrow("STAFF_ACCOUNT_PROTECTED");
});
it("HTTP rejects staff, malformed state, and foreign origin",async()=>{
  const admin=await cookie(f.email,f.company.initialPassword), c=await command("inactive"), url=path()+`/${f.staff.staffId}/status`;
  expect((await request(url,admin,c,"https://example.invalid")).status).toBe(403);
  expect((await request(url,admin,{...c,status:"unknown"})).status).toBe(400);
  await env.DB.prepare("UPDATE access_state SET must_change_password=0 WHERE user_id=?").bind(f.staffUser).run();
  const email=(await env.DB.prepare("SELECT email FROM user WHERE id=?").bind(f.staffUser).first<string>("email"))!;
  const member=await cookie(email,f.staff.initialPassword!);
  expect((await request(url,member,c)).status).toBe(403);
  expect(await revision()).toBe(c.expectedRevision);
});
it("a revocation after API authorization is rechecked inside the write batch",async()=>{
  const c=await command("inactive");
  const db={prepare:env.DB.prepare.bind(env.DB),batch:async<T>(statements:D1PreparedStatement[])=>{
    await env.DB.prepare("DELETE FROM company_admin WHERE company_id=? AND user_id=?").bind(f.company.companyId,f.company.userId).run();
    return env.DB.batch<T>(statements);
  }};
  await expect(change(c,f.company.userId,db)).rejects.toThrow("FORBIDDEN");
  expect(await state()).toMatchObject({status:"active",enabled:1}); expect(await revision()).toBe(c.expectedRevision);
});
it("new calculations exclude inactive/deleted staff and event participation without rewriting stored planning",async()=>{
  const second=await createStaff(env.DB,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),name:"架空追加スタッフ",staffNumber:"0002",email:`${crypto.randomUUID()}@example.invalid`});
  // Use the original complete profile for the remaining active person.
  const original=await loadSources(env.DB,f.company.companyId,f.team,"2026-10");
  for(const status of ["inactive","deleted"] as const){
    await change(await command(status));
    const sources=await loadSources(env.DB,f.company.companyId,f.team,"2026-10");
    expect(sources.staff).toEqual([{id:second.staffId}]);
    sources.versions.push(...original.versions.filter(v=>v.staff_id===f.staff.staffId).map(v=>({...v,staff_id:second.staffId,entity_id:second.staffId})));
    const compiled=compileInput(f.company.companyId,f.team,"2026-10",crypto.randomUUID(),sources);
    expect(compiled.input.staff.map(s=>s.id)).toEqual([second.staffId]);
    expect(compiled.input.events[0].staffIds).toEqual([]);
    expect(JSON.parse(sources.versions.find(v=>v.kind==="planning")!.payload)).toEqual(f.plan);
    sources.versions=sources.versions.map(v=>v.kind==="planning"?{...v,payload:JSON.stringify({...f.plan,events:[{...f.plan.events[0],staffIds:["unknown-staff"]}]})}:v);
    expect(()=>compileInput(f.company.companyId,f.team,"2026-10",crypto.randomUUID(),sources)).toThrow("UNKNOWN_STAFF");
  }
});

it('all inactive staff produce an actionable calculation error; activation restores the original participants',async()=>{
  await change(await command('inactive'));
  let sources=await loadSources(env.DB,f.company.companyId,f.team,'2026-10');
  expect(()=>compileInput(f.company.companyId,f.team,'2026-10',crypto.randomUUID(),sources)).toThrow('NO_ACTIVE_STAFF');
  await change(await command('active'));
  sources=await loadSources(env.DB,f.company.companyId,f.team,'2026-10');
  expect(compileInput(f.company.companyId,f.team,'2026-10',crypto.randomUUID(),sources).input.events).toEqual(f.plan.events);
  await expect(change(await command('active'))).rejects.toThrow('STAFF_STATUS_CONFLICT');
});
it('a shared account cannot be stopped and a silently retained session rolls back deactivation',async()=>{
  const other=await inputFixture(env.DB);
  await env.DB.prepare("INSERT INTO team_member(company_id,team_id,user_id,role,staff_id) VALUES (?,?,?,'team_admin',NULL)").bind(other.company.companyId,other.team,f.staffUser).run();
  await expect(change(await command('inactive'))).rejects.toThrow('STAFF_ACCOUNT_PROTECTED');
  await env.DB.prepare('DELETE FROM team_member WHERE company_id=? AND team_id=? AND user_id=?').bind(other.company.companyId,other.team,f.staffUser).run();
  const email=(await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(f.staffUser).first<string>('email'))!;
  await cookie(email,f.staff.initialPassword!);
  const c=await command('inactive');
  await env.DB.prepare('CREATE TRIGGER lifecycle_keep_session BEFORE DELETE ON session BEGIN SELECT RAISE(IGNORE); END').run();
  try{await expect(change(c)).rejects.toThrow();expect(await state()).toMatchObject({status:'active',enabled:1,banned:0});expect(await revision()).toBe(c.expectedRevision);}
  finally{await env.DB.prepare('DROP TRIGGER lifecycle_keep_session').run();}
  expect(await change(c)).toMatchObject({replayed:false});
});
