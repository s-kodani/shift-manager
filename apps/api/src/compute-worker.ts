import { dispatchJobs, jobMessage } from "./compute-jobs";
import { revalidationMessage } from "./revalidation-contract";
import { dispatchRevalidations } from "./publication-revalidation";
import { pruneExplanations } from './explanations';
import {admitMaintenance,releaseMaintenance} from './maintenance';
import {deliveryEnvironment} from './maintenance-delivery';
export async function handleJobBatch(batch: MessageBatch<unknown>, env: Env) {
  let lease:string|null;
  try{lease=await admitMaintenance(env.DB,'BACKGROUND',0,0,1);}catch{batch.retryAll({delaySeconds:60});return;}
  if(!lease){
    // Frozen databases have no accepted active work. Late duplicate delivery
    // can be acknowledged from a terminal receipt without starting any RPC.
    for(const message of batch.messages){
      const job=jobMessage.safeParse(message.body),service=revalidationMessage.safeParse(message.body);
      if(!job.success&&!service.success){message.ack();continue;}
      try{
        const row=job.success?await env.DB.prepare('SELECT state FROM compute_job WHERE id=? AND company_id=? AND team_id=?')
          .bind(job.data.jobId,job.data.companyId,job.data.teamId).first<{state:string}>():
          service.success?await env.DB.prepare('SELECT state FROM publication_revalidation_request WHERE id=? AND company_id=? AND team_id=?')
          .bind(service.data.requestId,service.data.companyId,service.data.teamId).first<{state:string}>():null;
        if(row&&!['QUEUED','RUNNING','CANCELLING','PENDING'].includes(row.state))message.ack();else message.retry({delaySeconds:60});
      }catch{message.retry({delaySeconds:60});}
    }
    return;
  }
  const scoped=deliveryEnvironment(env,lease);
  try{const result=await handleJobMessages(
    batch,
    (job) =>
      scoped.SOLVER.getByName(
        `company:${job.companyId}:team:${job.teamId}`,
      ).runJob(job),
    (message) =>
      scoped.SOLVER.getByName(
        `company:${message.companyId}:team:${message.teamId}`,
      ).runRevalidation(message),
  );await scoped.DB.prepare('SELECT 1 AS admitted').first();return result;}finally{await releaseMaintenance(env.DB,lease);}
}
export async function handleJobMessages(
  batch: MessageBatch<unknown>,
  run: (
    job: import("./compute-jobs").JobMessage,
  ) => Promise<import("./compute-execution").ExecutionResult>,
  revalidate?: (
    message: import("./revalidation-contract").RevalidationMessage,
  ) => Promise<import("./compute-execution").ExecutionResult>,
) {
  for (const message of batch.messages) {
    const service = revalidationMessage.safeParse(message.body);
    if (service.success && revalidate) {
      try {
        const outcome = await revalidate(service.data);
        if (outcome === "DONE") message.ack();
        else message.retry({ delaySeconds: 10 });
      } catch {
        message.retry({ delaySeconds: 30 });
      }
      continue;
    }
    const parsed = jobMessage.safeParse(message.body);
    if (!parsed.success) {
      message.ack();
      continue;
    } // Never use payload-provided object keys or input versions.
    try {
      const job = parsed.data;
      const outcome = await run(job);
      if (outcome === "DONE") message.ack();
      else message.retry({ delaySeconds: 10 });
    } catch {
      message.retry({ delaySeconds: 30 });
    }
  }
}
export async function recoverDeliveries(env: Env) {
  await dispatchJobs(env.DB, env.COMPUTE_QUEUE);
  await dispatchRevalidations(env.DB, env.COMPUTE_QUEUE);
  await pruneExplanations(env.DB);
}
