import { Container } from "@cloudflare/containers";
import {
  executeJob,
  recoverStoppedJob,
  type ExecutionResult,
} from "./compute-execution";
import { jobMessage, boundedBytes, type JobMessage } from "./compute-jobs";
import {
  authorizeFault,
  faultCommand,
  faultEvidence,
  type FaultCommand,
} from "./compute-faults";
import { confirmProcessStopped } from "./container-lifecycle";
import { checkDraftCandidate } from "./draft-check";
import {
  candidateCommand,
  type CandidateCommand,
  type CandidateResult,
} from "./draft-contract";
import {
  revalidationMessage,
  type RevalidationMessage,
} from "./revalidation-contract";
import {
  executeRevalidation,
  recoverInterruptedRevalidation,
} from "./publication-revalidation";

import { checkCancellationCandidate } from "./cancellation-check";
import {
  cancellationCandidateCommand,
  cancellationRpcResult,
  type CancellationCandidateCommand,
} from "./cancellation-contract";
import type { ContainerTransport } from "./compute-execution";
import { ProductError } from "./product";
import {optimizerBenchmark,type OptimizerBenchmark} from './optimizer-benchmark';
import {savedCandidateBenchmark,runSavedCandidateBenchmark,SavedProbeFailure,type SavedCandidateBenchmark} from './saved-candidate-benchmark';
import {maintenanceDatabase,maintenanceDeliveryDatabase} from './maintenance-database';
import {maintenanceBucket} from './maintenance-business';

export class OptimizerContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "1m";
  enableInternet = false;
  private executing = false;
  private executionSequence = 0;
  private readonly bootId = crypto.randomUUID();
  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS compute_fence (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL)",
      );
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS check_fence (id INTEGER PRIMARY KEY CHECK(id=1),request_id TEXT NOT NULL)",
      );
    });
  }
  executionState() {
    return {
      bootId: this.bootId,
      activeRpc: this.executing,
      persistedFence:
        this.ctx.storage.sql
          .exec("SELECT id FROM compute_fence WHERE id=1")
          .toArray().length === 1,
      persistedCheckFence: this.hasCheckFence(),
      processRunning: this.ctx.container?.running === true,
    };
  }
  private hasCheckFence() {
    return (
      this.ctx.storage.sql
        .exec("SELECT id FROM check_fence WHERE id=1")
        .toArray().length === 1
    );
  }
  private async recoverCheckFence(env=this.env) {
    const fence = this.ctx.storage.sql
      .exec<{ request_id: string }>(
        "SELECT request_id FROM check_fence WHERE id=1",
      )
      .toArray()[0];
    if (fence) {
      await this.terminateExecution();
      // Service checks store the complete internal message; manual checks store a
      // random UUID. Reclaim D1 only after the old process has actually stopped.
      if (fence.request_id.startsWith("{"))
        await recoverInterruptedRevalidation(
          env,
          revalidationMessage.parse(JSON.parse(fence.request_id)),
        );
      this.ctx.storage.sql.exec("DELETE FROM check_fence WHERE id=1");
    }
  }
  async runRevalidation(data: RevalidationMessage,leaseId?:string): Promise<ExecutionResult> {
    const message = revalidationMessage.parse(data);
    if (
      this.executing ||
      this.ctx.storage.sql
        .exec("SELECT id FROM compute_fence WHERE id=1")
        .toArray().length
    )
      return "BUSY";
    this.executing = true;
    let stopped = false;
    try {
      const env=this.deliveryExecutionEnvironment(leaseId);
      if(leaseId!==undefined)await env.DB.prepare('SELECT 1').first();
      await this.recoverCheckFence(env);
      this.ctx.storage.sql.exec(
        "INSERT INTO check_fence(id,request_id) VALUES(1,?)",
        JSON.stringify(message),
      );
      const deadline = Date.now() + 60_000;
      const result = await executeRevalidation(
        env,
        message,
        async (path, payload) => {
          if(leaseId!==undefined)await env.DB.prepare('SELECT 1').first();
          const body = JSON.stringify(payload);
          return this.containerFetch(`http://container${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(
                new TextEncoder().encode(body).byteLength,
              ),
            },
            body,
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
        },
        async () => {
          await this.terminateExecution();
          stopped = true;
        },
      );
      // DONE may have needed no container (duplicate or superseded delivery).
      if (result === "DONE" && !stopped) {
        await this.terminateExecution();
        stopped = true;
      }
      if (stopped)
        this.ctx.storage.sql.exec("DELETE FROM check_fence WHERE id=1");
      return result;
    } finally {
      this.executing = false;
    }
  }
  async checkDraft(data: CandidateCommand,leaseId?:string): Promise<CandidateResult> {
    const command = candidateCommand.parse(data);
    return this.runExclusiveCheck((transport, terminate) =>
      checkDraftCandidate(this.checkEnvironment(leaseId), command, transport, terminate),
    leaseId);
  }
  async benchmark(data: OptimizerBenchmark) {
    if(this.env.ENVIRONMENT!=='poc')throw new Error('BENCHMARK_FORBIDDEN');
    const command=optimizerBenchmark.parse(data);
    return this.runExclusiveCheck(async(_transport,terminate)=>{
      const body=JSON.stringify(command);
      const response=await this.containerFetch('http://container/benchmark',{
        method:'POST',headers:{'content-type':'application/json','content-length':String(new TextEncoder().encode(body).byteLength)},
        body,signal:AbortSignal.timeout(150_000),
      });
      const report=new TextDecoder().decode(await boundedBytes(response.body,512_000));
      await terminate();
      return {httpStatus:response.status,body:report,processStopped:this.ctx.container?.running===false};
    });
  }
  async benchmarkSaved(data: SavedCandidateBenchmark) {
    if(this.env.ENVIRONMENT!=='poc')throw new Error('BENCHMARK_FORBIDDEN');
    const command=savedCandidateBenchmark.parse(data);
    return this.runExclusiveCheck(async(_transport,terminate)=>{
      const deadline=Date.now()+150_000;
      try{
        const report=await runSavedCandidateBenchmark(command,async(path,payload)=>{
          const body=payload===undefined?undefined:JSON.stringify(payload);
          return this.containerFetch(`http://container${path}`,{
            method:body===undefined?'GET':'POST',
            headers:body===undefined?undefined:{'content-type':'application/json',
              'content-length':String(new TextEncoder().encode(body).byteLength),
              ...(path==='/solve'?{'x-optimizer-profile':'mvp-joint-seed-v1'}:{})},
            body,signal:AbortSignal.timeout(Math.max(1,deadline-Date.now())),
          });
        },deadline);
        return {httpStatus:200,body:JSON.stringify(report),processStopped:true};
      }catch(error){
        if(!(error instanceof SavedProbeFailure))throw error;
        return {httpStatus:502,body:JSON.stringify({error:'SAVED_PROBE_FAILED',diagnostic:error.diagnostic}),processStopped:true};
      }finally{
        // An error still stops the owned process. A failed stop retains the
        // durable fence and prevents a replacement probe from overlapping it.
        await terminate();
      }
    });
  }
  async checkCancellation(data: CancellationCandidateCommand,leaseId?:string): Promise<string> {
    const command = cancellationCandidateCommand.parse(data);
    // The checker includes extensible JSON metrics. Transfer the validated,
    // bounded certificate as JSON rather than treating unknown RPC data as safe.
    try {
      const result = await this.runExclusiveCheck((transport, terminate) =>
        checkCancellationCandidate(this.checkEnvironment(leaseId), command, transport, terminate),
      leaseId);
      return JSON.stringify(cancellationRpcResult.parse({ ok: true, result }));
    } catch (error) {
      const business =
        error instanceof ProductError
          ? error
          : error instanceof Error && error.message === "CHECK_BUSY"
            ? new ProductError("CHECK_BUSY")
            : null;
      if (!business) throw error;
      return JSON.stringify(
        cancellationRpcResult.parse({
          ok: false,
          error: business.code,
          status: business.status,
        }),
      );
    }
  }
  private checkEnvironment(leaseId?:string){
    if(leaseId===undefined)return this.env;
    const DB=maintenanceDatabase(this.env.DB,leaseId,1);
    return {...this.env,DB,INPUTS:maintenanceBucket(this.env.INPUTS,DB)};
  }
  private deliveryExecutionEnvironment(leaseId?:string){
    if(leaseId===undefined)return this.env;
    const DB=maintenanceDeliveryDatabase(this.env.DB,leaseId);
    return {...this.env,DB,INPUTS:maintenanceBucket(this.env.INPUTS,DB)};
  }
  private async runExclusiveCheck<T>(
    check: (
      transport: ContainerTransport,
      terminate: () => Promise<void>,
    ) => Promise<T>,leaseId?:string,
  ): Promise<T> {
    if (
      this.executing ||
      this.ctx.storage.sql
        .exec("SELECT id FROM compute_fence WHERE id=1")
        .toArray().length
    )
      throw new Error("CHECK_BUSY");
    this.executing = true;
    let stopped = false;
    try {
      // Hold activeRpc before the D1 check. A retirement racing that check
      // cannot pass freeze's DO inspection while this RPC can start a process.
      // A delayed RPC after retirement fails here without creating a fence.
      if(leaseId!==undefined)await maintenanceDatabase(this.env.DB,leaseId,1).prepare('SELECT 1').first();
      await this.recoverCheckFence(this.checkEnvironment(leaseId));
      this.ctx.storage.sql.exec(
        "INSERT INTO check_fence(id,request_id) VALUES (1,?)",
        crypto.randomUUID(),
      );
      const deadline = Date.now() + 60_000;
      return await check(
        async (path, payload) => {
          const body = JSON.stringify(payload);
          return this.containerFetch(`http://container${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(
                new TextEncoder().encode(body).byteLength,
              ),
            },
            body,
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
        },
        async () => {
          await this.terminateExecution();
          stopped = true;
        },
      );
    } finally {
      if (stopped)
        this.ctx.storage.sql.exec("DELETE FROM check_fence WHERE id=1");
      this.executing = false;
    }
  }
  async interruptOwnedProbe(data: JobMessage, input: FaultCommand) {
    const message = jobMessage.parse(data),
      command = faultCommand.parse(input);
    const sequence = this.executionSequence;
    await authorizeFault(this.env.DB, this.env.ENVIRONMENT, message, command);
    if (await faultEvidence(this.env.DB, command)) return { replayed: true };
    const active = () => {
      const fence = this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM compute_fence WHERE id=1",
        )
        .toArray()[0];
      if (
        !this.executing ||
        sequence !== this.executionSequence ||
        !this.ctx.container?.running ||
        !fence
      )
        return false;
      const persisted = jobMessage.parse(JSON.parse(fence.payload));
      return (
        persisted.jobId === message.jobId &&
        persisted.companyId === message.companyId &&
        persisted.teamId === message.teamId
      );
    };
    if (!active()) throw new Error("FAULT_NOT_RUNNING");
    await this.env.DB.prepare(
      "INSERT INTO compute_fault_probe(id,probe_id,attempt,mode,before_boot,requested_at) VALUES (?,?,?,?,?,?)",
    )
      .bind(
        command.operationId,
        command.probeId,
        command.expectedAttempt,
        command.mode,
        this.bootId,
        Date.now(),
      )
      .run();
    // Do not interrupt a replacement/finished job after the evidence write yielded.
    if (!active()) throw new Error("FAULT_NOT_RUNNING");
    if (command.mode === "restart") {
      this.ctx.abort("CONTROLLED_POC_RESTART");
      throw new Error("RESET_DID_NOT_ABORT");
    }
    await this.terminateExecution();
    return { replayed: false, stopped: true };
  }
  async onActivityExpired() {
    if (this.executing) {
      this.renewActivityTimeout();
      return;
    }
    await this.terminateExecution();
  }
  async releaseIdleProbe() {
    if (
      this.executing ||
      this.hasCheckFence() ||
      this.ctx.storage.sql
        .exec("SELECT id FROM compute_fence WHERE id=1")
        .toArray().length
    )
      return { released: false };
    await this.terminateExecution();
    return { released: true, ...this.executionState() };
  }
  async diagnoseTransport() {
    if (
      this.executing ||
      this.hasCheckFence() ||
      this.ctx.storage.sql
        .exec("SELECT id FROM compute_fence WHERE id=1")
        .toArray().length
    )
      return { busy: true };
    const response = await this.containerFetch("http://container/health", {
      signal: AbortSignal.timeout(30_000),
    });
    const body = new TextDecoder().decode(
      await boundedBytes(response.body, 4096),
    );
    return {
      busy: false,
      status: response.status,
      processRunning: this.ctx.container?.running === true,
      portTimeout: /port.*timeout|timeout.*port/i.test(body),
      capacityError: /capacity|max.*instance|instance.*limit/i.test(body),
      connectionError: /connect|network/i.test(body),
      startupError: /start|image/i.test(body),
      healthOk: response.ok && /"status"\s*:\s*"ok"/.test(body),
    };
  }
  protected async terminateExecution() {
    const container = this.ctx.container;
    if (!container) throw new Error("PROCESS_STOP_UNCONFIRMED");
    await confirmProcessStopped(container);
  }
  async runJob(data: JobMessage,leaseId?:string): Promise<ExecutionResult> {
    const message = jobMessage.parse(data);
    if (this.executing) return "BUSY";
    this.executing = true;
    this.executionSequence++;
    try {
      const env=this.deliveryExecutionEnvironment(leaseId);
      if(leaseId!==undefined)await env.DB.prepare('SELECT 1').first();
      await this.recoverCheckFence(env);
      const previous = this.ctx.storage.sql
        .exec<{ payload: string }>(
          "SELECT payload FROM compute_fence WHERE id=1",
        )
        .toArray()[0];
      if (previous) {
        // An in-memory active RPC is never displaced by lease expiry. After an
        // object restart, kill the surviving process before reclaiming its D1 job.
        await this.terminateExecution();
        if (this.env.ENVIRONMENT === "poc")
          await env.DB.prepare(
            `UPDATE compute_fault_probe SET recovery_boot=?,recovery_stopped_at=?
     WHERE probe_id=? AND mode='restart' AND before_boot!=? AND recovery_stopped_at IS NULL`,
          )
            .bind(
              this.bootId,
              Date.now(),
              previousMessageId(previous.payload),
              this.bootId,
            )
            .run();
        await recoverStoppedJob(
          env,
          jobMessage.parse(JSON.parse(previous.payload)),
        );
        this.ctx.storage.sql.exec("DELETE FROM compute_fence WHERE id=1");
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO compute_fence(id,payload) VALUES (1,?)",
        JSON.stringify(message),
      );
      const deadline = Date.now() + 150_000;
      const outcome = await executeJob(
        env,
        message,
        async (path, payload) => {
          if(leaseId!==undefined)await env.DB.prepare('SELECT 1').first();
          const body = JSON.stringify(payload);
          return this.containerFetch(`http://container${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(path === '/solve' && this.env.OPTIMIZER_SOLVE_PROFILE ? {'x-optimizer-profile':this.env.OPTIMIZER_SOLVE_PROFILE} : {}),
              "content-length": String(
                new TextEncoder().encode(body).byteLength,
              ),
            },
            body,
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
        },
        () => this.terminateExecution(),
      );
      if (outcome !== "BUSY")
        this.ctx.storage.sql.exec("DELETE FROM compute_fence WHERE id=1");
      return outcome;
    } finally {
      this.executing = false;
    }
  }
}

function previousMessageId(payload: string) {
  return jobMessage.parse(JSON.parse(payload)).jobId;
}
