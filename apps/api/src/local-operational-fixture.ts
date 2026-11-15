// Imported only by the loopback development entry, never by product or PoC.
import { z } from "zod";
import { optimizerInputSchema, optimizerAssignmentsSchema } from "../../../packages/contracts/optimizer-input.generated";
import { registeredOperationalFixture, disableRegisteredFixture } from "../../../tests/fixtures/registered-operational";

export const localOperationalSource = z.object({
  input: optimizerInputSchema.refine(d =>
    d.tenantId === "fictional-company-a" &&
    /^fictional-operational-(10|101|500)-30-v1$/.test(d.jobId) &&
    [10,101,500].includes(d.staff.length) && d.slotMinutes === 30 &&
    d.jobId === `fictional-operational-${d.staff.length}-30-v1`,
    "FICTIONAL_OPERATIONAL_SOURCE_REQUIRED"),
  assignments: optimizerAssignmentsSchema,
}).strict();

export async function createLocalOperationalFixture(env: Pick<Env,"DB"|"INPUTS">, source: z.infer<typeof localOperationalSource>) {
  const credentials: {
    admin: {email:string;password:string}|null;
    staffLogin: {email:string;staffId:string;initialPassword:string}|null;
  } = {admin:null,staffLogin:null};
  const f = await registeredOperationalFixture(env, source, undefined, {
    companyIssued: (issued,email) => {credentials.admin={email,password:issued.initialPassword};},
    firstStaffIssued: (email,staffId,initialPassword) => {credentials.staffLogin={email,staffId,initialPassword};},
  });
  try {
    if(!credentials.admin||!credentials.staffLogin)throw Error("LOCAL_FIXTURE_CREDENTIALS_MISSING");
    // Direct setup temporarily permits the admin's business functions. Restore
    // the product's initial-change gate before returning browser credentials.
    await env.DB.prepare("UPDATE access_state SET must_change_password=1 WHERE user_id=?").bind(f.userId).run();
    const fixtureId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO local_ui_fixture(id,company_id,expires_at) VALUES (?,?,?)")
      .bind(fixtureId,f.companyId,Date.now()+60*60_000).run();
    return {...credentials.admin,fixtureId,companyId:f.companyId,teamId:f.team,month:f.frozen.input.month,
      staffLogin:credentials.staffLogin,staffCount:f.frozen.input.staff.length,snapshotId:f.snapshotId,
      inputRevision:f.revision,requiredHistoryCount:f.frozen.input.history.length};
  } catch(error) {
    await disableRegisteredFixture(env,f.companyId);
    throw error;
  }
}
