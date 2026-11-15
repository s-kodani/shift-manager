// Explicit local-only development entry; neither product nor PoC imports it.
import { timingSafeEqual } from "node:crypto";
import worker, { createApp } from "./index";
import { inputFixture } from "./input-probes";
import { provisionCompany } from "./product";
import { boundedBytes,jobMessage } from "./compute-jobs";
import { z } from "zod";
import { localOperationalSource, createLocalOperationalFixture } from "./local-operational-fixture";
import { candidateCommand } from "./draft-contract";
import {withMaintenance,MaintenanceError,maintenanceResponse,requireRecoverySecurity,admitMaintenance,releaseMaintenance} from './maintenance';
export { OptimizerContainer } from "./optimizer-container";
const command = z.object({ fixtureId: z.string().uuid() }).strict();
async function cleanup(env: Env, id: string) {
  const owner = await env.DB.prepare(
    "SELECT company_id FROM local_ui_fixture WHERE id=? AND cleaned_at IS NULL",
  )
    .bind(id)
    .first<{ company_id: string }>();
  if (!owner) return;
  const users = `SELECT user_id FROM company_admin WHERE company_id=? UNION SELECT user_id FROM staff WHERE company_id=?`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE access_state SET enabled=0 WHERE user_id IN (${users})`,
    ).bind(owner.company_id, owner.company_id),
    env.DB.prepare(`DELETE FROM session WHERE userId IN (${users})`).bind(
      owner.company_id,
      owner.company_id,
    ),
    env.DB.prepare(
      `UPDATE account SET password=NULL WHERE userId IN (${users})`,
    ).bind(owner.company_id, owner.company_id),
    env.DB.prepare("UPDATE local_ui_fixture SET cleaned_at=? WHERE id=?").bind(
      Date.now(),
      id,
    ),
  ]);
}
const localWorker = {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (
      env.ENVIRONMENT !== "local" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      return Response.json({ error: "LOCAL_ONLY" }, { status: 403 });
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS local_ui_fixture(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,expires_at INTEGER NOT NULL,cleaned_at INTEGER)",
    ).run();
    const expired = await env.DB.prepare(
      "SELECT id FROM local_ui_fixture WHERE expires_at<? AND cleaned_at IS NULL",
    )
      .bind(Date.now())
      .all<{ id: string }>();
    for (const row of expired.results) await cleanup(env, row.id);
    if (!url.pathname.startsWith("/__local/"))
      return createApp().fetch(request, env, ctx);
    const actual = new TextEncoder().encode(
        request.headers.get("authorization") ?? "",
      ),
      expected = new TextEncoder().encode(`Bearer ${env.POC_TOKEN}`);
    if (
      !env.POC_TOKEN ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    const headers = {
      "cache-control": "no-store",
      "content-type": "application/json",
    };
    if (request.method !== "POST")
      return Response.json({ error: "NOT_FOUND" }, { status: 404, headers });
    try {
      if (url.pathname === '/__local/redeliver'||url.pathname === '/__local/redelivery-state') {
        await requireRecoverySecurity(env.DB,env.RECOVERY_SECURITY_ID);
        const body=command.extend({teamId:z.string().uuid(),jobId:z.string().uuid()}).strict()
          .parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,1024))));
        const owner=await env.DB.prepare(`SELECT f.company_id FROM local_ui_fixture f JOIN team t ON t.company_id=f.company_id
          WHERE f.id=? AND t.id=? AND f.cleaned_at IS NULL AND f.expires_at>?`)
          .bind(body.fixtureId,body.teamId,Date.now()).first<{company_id:string}>();
        if(!owner)return Response.json({error:'NOT_FOUND'},{status:404,headers});
        if(url.pathname === '/__local/redelivery-state'){
          const exists=await env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE name='local_redelivery_probe'").first();
          const row=exists?await env.DB.prepare('SELECT job_id,state FROM local_redelivery_probe WHERE job_id=? AND fixture_id=?').bind(body.jobId,body.fixtureId).first():null;
          return row?Response.json(row,{headers}):Response.json({error:'NOT_FOUND'},{status:404,headers});
        }
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS local_redelivery_probe(job_id TEXT PRIMARY KEY,fixture_id TEXT NOT NULL,state TEXT NOT NULL,FOREIGN KEY(fixture_id) REFERENCES local_ui_fixture(id))').run();
        await env.DB.prepare("INSERT INTO local_redelivery_probe VALUES (?,?,'DISPATCHED')").bind(body.jobId,body.fixtureId).run();
        await env.COMPUTE_QUEUE.send({version:1,companyId:owner.company_id,teamId:body.teamId,jobId:body.jobId});
        return Response.json({queued:true},{headers});
      }
      if (url.pathname === "/__local/operational-check") {
        const body=command.extend({snapshotId:z.string().uuid(),
          assignments:candidateCommand.shape.assignments,locks:candidateCommand.shape.locks,
          exceptions:candidateCommand.shape.exceptions,
        }).strict().parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,16*1024*1024))));
        const owned=await env.DB.prepare(`SELECT s.company_id,s.team_id,a.user_id FROM input_snapshot s
          JOIN local_ui_fixture f ON f.company_id=s.company_id
          JOIN company_admin a ON a.company_id=s.company_id
          WHERE f.id=? AND f.cleaned_at IS NULL AND f.expires_at>? AND s.id=?`)
          .bind(body.fixtureId,Date.now(),body.snapshotId).first<{company_id:string;team_id:string;user_id:string}>();
        if(!owned)return Response.json({error:"NOT_FOUND"},{status:404,headers});
        const result=await env.SOLVER.getByName(`company:${owned.company_id}:team:${owned.team_id}`).checkDraft({companyId:owned.company_id,
          teamId:owned.team_id,userId:owned.user_id,snapshotId:body.snapshotId,
          assignments:body.assignments,locks:body.locks,exceptions:body.exceptions});
        return Response.json({result,scope:"local-check-only; no draft/publication commit"},{headers});
      }
      if (url.pathname === "/__local/operational-fixture") {
        const source=localOperationalSource.parse(JSON.parse(new TextDecoder().decode(
          await boundedBytes(request.body,16*1024*1024),
        )));
        return Response.json(await createLocalOperationalFixture(env,source),{headers});
      }
      if (url.pathname === "/__local/fixture") {
        const body = z
          .object({ profile: z.enum(["empty", "configured"]).optional() })
          .strict()
          .parse(
            JSON.parse(
              new TextDecoder().decode(await boundedBytes(request.body, 1024)),
            ),
          );
        const email = `${crypto.randomUUID()}@example.invalid`;
        const f =
            body.profile === "empty"
              ? {
                  email,
                  team: "",
                  company: await provisionCompany(env.DB, {
                    name: "架空初期設定企業",
                    adminName: "架空管理者",
                    adminEmail: email,
                  }),
                }
              : await inputFixture(env.DB),
          id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO local_ui_fixture(id,company_id,expires_at) VALUES (?,?,?)",
        )
          .bind(id, f.company.companyId, Date.now() + 60 * 60_000)
          .run();
        await env.DB.prepare(
          "UPDATE access_state SET must_change_password=1 WHERE user_id=?",
        )
          .bind(f.company.userId)
          .run();
        return Response.json(
          {
            fixtureId: id,
            email: f.email,
            password: f.company.initialPassword,
            companyId: f.company.companyId,
            teamId: f.team,
            month: "2026-10",
            staffLogin:
              "staff" in f
                ? {
                    staffId: f.staff.staffId,
                    email: await env.DB.prepare(
                      "SELECT email FROM user WHERE id=?",
                    )
                      .bind(f.staffUser)
                      .first<string>("email"),
                    initialPassword: f.staff.initialPassword,
                  }
                : null,
          },
          { headers },
        );
      }
      if (url.pathname === "/__local/status") {
        const body = command.parse(
          JSON.parse(
            new TextDecoder().decode(await boundedBytes(request.body, 1024)),
          ),
        );
        const owner = await env.DB.prepare(
          "SELECT company_id FROM local_ui_fixture WHERE id=? AND cleaned_at IS NULL AND expires_at>?",
        )
          .bind(body.fixtureId, Date.now())
          .first<{ company_id: string }>();
        if (!owner)
          return Response.json(
            { error: "NOT_FOUND" },
            { status: 404, headers },
          );
        const teams = await env.DB.prepare(
          "SELECT id FROM team WHERE company_id=?",
        )
          .bind(owner.company_id)
          .all<{ id: string }>();
        const executions = [];
        for (const team of teams.results)
          executions.push({
            teamId: team.id,
            ...(await env.SOLVER.getByName(
              `company:${owner.company_id}:team:${team.id}`,
            ).executionState()),
          });
        return Response.json({ executions }, { headers });
      }
      if (url.pathname === "/__local/recover") {
        const body = command.parse(
          JSON.parse(
            new TextDecoder().decode(await boundedBytes(request.body, 1024)),
          ),
        );
        const owner = await env.DB.prepare(
          "SELECT company_id FROM local_ui_fixture WHERE id=? AND cleaned_at IS NULL AND expires_at>?",
        )
          .bind(body.fixtureId, Date.now())
          .first<{ company_id: string }>();
        if (!owner)
          return Response.json(
            { error: "NOT_FOUND" },
            { status: 404, headers },
          );
        const jobs = await env.DB.prepare(
          "SELECT id,team_id FROM compute_job WHERE company_id=? AND state IN ('QUEUED','RUNNING','CANCELLING')",
        )
          .bind(owner.company_id)
          .all<{ id: string; team_id: string }>();
        for (const job of jobs.results)
          await env.COMPUTE_QUEUE.send({
            version: 1,
            companyId: owner.company_id,
            teamId: job.team_id,
            jobId: job.id,
          });
        return Response.json({ redelivered: jobs.results.length }, { headers });
      }
      if (url.pathname === "/__local/cleanup") {
        const body = command.parse(
          JSON.parse(
            new TextDecoder().decode(await boundedBytes(request.body, 1024)),
          ),
        );
        await cleanup(env, body.fixtureId);
        return Response.json({ cleaned: true }, { headers });
      }
      return Response.json({ error: "NOT_FOUND" }, { status: 404, headers });
    } catch (error) {
      if(error instanceof MaintenanceError)return maintenanceResponse();
      return Response.json(
        { error: "LOCAL_FIXTURE_FAILED" },
        { status: 500, headers },
      );
    }
  },
} satisfies ExportedHandler<Env>;
export default {
 ...localWorker,
 async queue(batch:MessageBatch<unknown>,env:Env){
  const exists=env.ENVIRONMENT==='local'&&await env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE name='local_redelivery_probe'").first();
  if(!exists)return worker.queue(batch,env);
  const lease=await admitMaintenance(env.DB,'BACKGROUND');
  if(!lease)return worker.queue(batch,env);
  try{
  const outcomes=new Map<string,string>();
  const messages=batch.messages.map(message=>new Proxy(message,{get(target,key){
    if(key==='ack'||key==='retry')return (...args:unknown[])=>{
      const result=Reflect.apply(Reflect.get(target,key),target,args),parsed=jobMessage.safeParse(target.body);
      if(parsed.success)outcomes.set(parsed.data.jobId,key==='ack'?'ACKED':'RETRY');return result;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}));
  const observed=new Proxy(batch,{get(target,key){if(key==='messages')return messages;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await worker.queue(observed,env);
  for(const [jobId,state] of outcomes)await env.DB.prepare('UPDATE local_redelivery_probe SET state=? WHERE job_id=?').bind(state,jobId).run();
  }finally{await releaseMaintenance(env.DB,lease);}
 },
 async fetch(request:Request,env:Env,ctx:ExecutionContext){
  try{return await withMaintenance(env.DB,'FOREGROUND',()=>localWorker.fetch(request,env,ctx));}
  catch(error){if(error instanceof MaintenanceError)return maintenanceResponse();throw error;}
 },
} satisfies ExportedHandler<Env>;
