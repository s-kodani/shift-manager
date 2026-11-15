import { runAuthProbes, runD1Probes } from './poc-probes';
import {finalD1Command,finalD1Probe} from './final-d1-probe';
import { runProductProbes } from './product-probes';
import { runInputProbes } from './input-probes';
import { createApp } from './index';
import { resetPagePaths } from './reset-page';
import { cleanupExpiredMailProbes, startMailProbe, inspectMailProbe, mailProbeInput, mailProbeStatus, mailProbeConfiguration, ResetMailProbeFailure, inspectMailTransport } from './reset-mail-probe';

export {OptimizerContainer} from './optimizer-container';
import {handleJobBatch,recoverDeliveries} from './compute-worker';
import {pruneAuthLimits} from './auth-request-limit';
import {computeProbeCommand,startComputeProbe,inspectComputeProbe,cleanupComputeProbe,cleanupExpiredComputeProbes,diagnoseComputeProbe,interruptComputeProbe} from './compute-probes';
import {faultCommand} from './compute-faults';
import {boundedBytes} from './compute-jobs';
import {runCsvAssetProbes} from './csv-asset-probes';
import {runStaffCsvProbes,inspectStaffCsvProbe,cleanupStaffCsvProbe,staffCsvProbeCommand,staffCsvProbeOwner} from './staff-csv-probes';
import {runSubmissionProbes,inspectSubmissionProbe,cleanupSubmissionProbe,submissionProbeCommand} from './staff-submission-probes';
import {explainOwnedComputeProbe,explanationProbeCommand} from './explanation-probes';
import {ProductError} from './product';
import {z} from 'zod';
import {cancellationProbeCommand,runCancellationProbe,cleanupExpiredCancellationProbes} from './cancellation-probes';
import {finalFixturePrepare,finalFixtureCommand,prepareFinalFixture,controlFinalFixture,finalDeliveryCommand,probeFinalDelivery} from './final-fixture-probes';
import {optimizerBenchmark} from './optimizer-benchmark';
import {savedCandidateBenchmark} from './saved-candidate-benchmark';
import {pocDeployPreflight} from './poc-preflight';
import {withMaintenance,MaintenanceError,maintenanceResponse} from './maintenance';
import {privatePocAccess} from './poc-browser-access';

const pocWorker = {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext) {
    const path = new URL(request.url).pathname;
    // Reset links retain their existing token protection. Product requests can
    // use browser Basic auth; PoC operations require the separate Bearer token.
    if ((request.method === 'GET' || request.method === 'HEAD') && resetPagePaths.has(path)) {
      return createApp().fetch(request, env, ctx);
    }
    if (request.method === 'POST' && path === '/api/auth/reset-password') {
      try {
        await cleanupExpiredMailProbes(env.DB);
        return await createApp().fetch(request, env, ctx);
      } catch {
        return Response.json({error:'RESET_UNAVAILABLE'}, {status:503,headers:{'cache-control':'no-store'}});
      }
    }
    const denied=privatePocAccess(request,env);if(denied)return denied;
    if (['/api/auth/sign-in/email','/api/auth/request-password-reset','/api/auth/get-session','/api/auth/sign-out','/api/password'].includes(path)) {
      return createApp().fetch(request, env, ctx);
    }
    // Both outer access methods use the same product router. Business APIs
    // require a live Better Auth session, first change and company/team rights.
    if ((!path.startsWith('/api/auth/') && path.startsWith('/api/')) ||
        (['GET','HEAD'].includes(request.method) && (path==='/app' || path.startsWith('/app-assets/')))) {
      const app=createApp();
      if(path.startsWith('/api/')){
        const parts=path.split('/'),method=request.method==='HEAD'?'GET':request.method;
        const registered=app.routes.some(route=>route.method===method && !route.path.startsWith('/api/auth/') &&
          route.path.split('/').length===parts.length && route.path.split('/').every((part,index)=>
            part.startsWith(':') ? parts[index].length>0 : part===parts[index]));
        if(!registered)return Response.json({error:'NOT_FOUND'},{status:404});
      }
      if(env.ENVIRONMENT!=='poc')return Response.json({error:'FORBIDDEN'},{status:403});
      return app.fetch(request,env,ctx);
    }
    if (request.method !== 'POST') return Response.json({error:'NOT_FOUND'}, {status:404});
    try {
      if(path==='/__poc/final-d1'){
        try{return Response.json(await finalD1Probe(env,finalD1Command.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,1024))))),{headers:{'cache-control':'no-store'}});}
        catch(error){const limit=error instanceof Error&&error.message==='BODY_LIMIT';return Response.json({error:limit?'BODY_LIMIT':error instanceof ProductError?error.code:error instanceof z.ZodError||error instanceof SyntaxError?'INVALID_INPUT':'PROBE_FAILED'},{status:limit?413:error instanceof ProductError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,headers:{'cache-control':'no-store'}});}
      }
      if(path==='/__poc/final-fixture'){
        const body=JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,16*1024*1024)));
        return Response.json(await prepareFinalFixture(env,finalFixturePrepare.parse(body)),{headers:{'cache-control':'no-store'}});
      }
      if(path==='/__poc/final-control'){
        const body=JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,2048)));
        return Response.json(await controlFinalFixture(env,finalFixtureCommand.parse(body)),{headers:{'cache-control':'no-store'}});
      }
      if(path==='/__poc/final-delivery'){
        const body=JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,2048)));
        return Response.json(await probeFinalDelivery(env,finalDeliveryCommand.parse(body)),{headers:{'cache-control':'no-store'}});
      }
      if(path==='/__poc/deploy-preflight'){
        if(env.ENVIRONMENT!=='poc')return Response.json({error:'FORBIDDEN'},{status:403});
        return Response.json(await pocDeployPreflight(env,name=>env.SOLVER.getByName(name).executionState()),{headers:{'cache-control':'no-store'}});
      }
      if(path==='/__poc/cancellation'){
        try{const c=cancellationProbeCommand.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,2048))));return Response.json(await runCancellationProbe(env,c),{headers:{'cache-control':'no-store'}});}
        catch(error){const limit=error instanceof Error&&error.message==='BODY_LIMIT';return Response.json({error:limit?'BODY_LIMIT':error instanceof ProductError?error.code:error instanceof z.ZodError||error instanceof SyntaxError?'INVALID_INPUT':'PROBE_FAILED'},{status:limit?413:error instanceof ProductError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,headers:{'cache-control':'no-store'}});}
      }
      if(path==='/__poc/compute-explanation'){
        try{
          const c=explanationProbeCommand.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,1024))));
          return Response.json(await explainOwnedComputeProbe(env,c),{headers:{'cache-control':'no-store'}});
        }catch(error){const limit=error instanceof Error&&error.message==='BODY_LIMIT';return Response.json({error:limit?'BODY_LIMIT':error instanceof ProductError?error.code:error instanceof z.ZodError||error instanceof SyntaxError?'INVALID_INPUT':'PROBE_FAILED'},{status:limit?413:error instanceof ProductError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,headers:{'cache-control':'no-store'}});}
      }
      if (['/__poc/staff-submission','/__poc/staff-submission-status','/__poc/staff-submission-cleanup'].includes(path)) {
        try {
          const command=submissionProbeCommand.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,1024))));
          return Response.json(path==='/__poc/staff-submission'?await runSubmissionProbes(env,command):path==='/__poc/staff-submission-status'?await inspectSubmissionProbe(env,command.probeId):await cleanupSubmissionProbe(env,command.probeId),{headers:{'cache-control':'no-store'}});
        }catch(error){
          const limit=error instanceof Error&&error.message==='BODY_LIMIT';
          return Response.json({error:limit?'BODY_LIMIT':error instanceof ProductError?error.code:error instanceof z.ZodError||error instanceof SyntaxError?'INVALID_INPUT':'PROBE_FAILED'},
            {status:limit?413:error instanceof ProductError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,headers:{'cache-control':'no-store'}});
        }
      }
      if (['/__poc/staff-csv','/__poc/staff-csv-status','/__poc/staff-csv-cleanup'].includes(path)) {
        try {
          const body=JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,1024)));
          const command=(path==='/__poc/staff-csv'?staffCsvProbeCommand:staffCsvProbeOwner).parse(body);
          return Response.json(path==='/__poc/staff-csv'?await runStaffCsvProbes(env,staffCsvProbeCommand.parse(command)):path==='/__poc/staff-csv-status'?await inspectStaffCsvProbe(env,command.probeId):await cleanupStaffCsvProbe(env,command.probeId),{headers:{'cache-control':'no-store'}});
        } catch(error) {
          const bodyLimit=error instanceof Error&&error.message==='BODY_LIMIT';
          return Response.json({error:bodyLimit?'BODY_LIMIT':error instanceof ProductError?error.code:error instanceof z.ZodError||error instanceof SyntaxError?'INVALID_INPUT':'PROBE_FAILED'},{status:bodyLimit?413:error instanceof ProductError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,headers:{'cache-control':'no-store'}});
        }
      }
      if(path==='/__poc/compute-start')return Response.json(await startComputeProbe(env));
      if(path==='/__poc/compute-interrupt'){
        const body=JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,1024)));
        return Response.json(await interruptComputeProbe(env,faultCommand.parse(body)),{headers:{'cache-control':'no-store'}});
      }
      if(path==='/__poc/compute-status'||path==='/__poc/compute-cleanup'||path==='/__poc/compute-diagnose'){
        const body=JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,1024)));
        const {probeId}=computeProbeCommand.parse(body);
        return Response.json(path==='/__poc/compute-status'?await inspectComputeProbe(env,probeId):path==='/__poc/compute-diagnose'?await diagnoseComputeProbe(env,probeId):await cleanupComputeProbe(env,probeId),{headers:{'cache-control':'no-store'}});
      }
      if (path === '/__poc/reset-mail-config') return Response.json(mailProbeConfiguration(env), {headers:{'cache-control':'no-store'}});
      if (path === '/__poc/reset-mail-transport') return Response.json(await inspectMailTransport(), {headers:{'cache-control':'no-store'}});
      if (path === '/__poc/reset-mail' || path === '/__poc/reset-mail-status') {
        const reader = request.body?.getReader();
        if (!reader) return Response.json({error:'INVALID_INPUT'}, {status:400});
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024) { await reader.cancel(); return Response.json({error:'BODY_LIMIT'}, {status:413}); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        let body: unknown;
        try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { return Response.json({error:'INVALID_INPUT'}, {status:400}); }
        const parsed = (path === '/__poc/reset-mail' ? mailProbeInput : mailProbeStatus).safeParse(body);
        if (!parsed.success) return Response.json({error:'INVALID_INPUT'}, {status:400});
        const result = path === '/__poc/reset-mail' ? await startMailProbe(env, mailProbeInput.parse(parsed.data)) : await inspectMailProbe(env.DB, mailProbeStatus.parse(parsed.data));
        return Response.json(result, {headers: {'cache-control':'no-store'}});
      }
      if(path==='/__poc/optimizer-state')return Response.json(await env.SOLVER.getByName('synthetic-poc').executionState());
      if(path==='/__poc/optimizer-benchmark'){
        if(env.ENVIRONMENT!=='poc')return Response.json({error:'FORBIDDEN'},{status:403});
        let command:z.infer<typeof optimizerBenchmark>;
        try{command=optimizerBenchmark.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,4_000_000))));}
        catch(error){return Response.json({error:'INVALID_BENCHMARK'},{status:error instanceof Error&&error.message==='BODY_LIMIT'?413:400});}
        const result=await env.SOLVER.getByName('synthetic-poc').benchmark(command);
        return new Response(result.body,{status:result.httpStatus,headers:{'content-type':'application/json','cache-control':'no-store','x-poc-process-stopped':String(result.processStopped)}});
      }
      if(path==='/__poc/optimizer-saved-benchmark'){
        if(env.ENVIRONMENT!=='poc')return Response.json({error:'FORBIDDEN'},{status:403});
        let command:z.infer<typeof savedCandidateBenchmark>;
        try{command=savedCandidateBenchmark.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,16_000_000))));}
        catch(error){return Response.json({error:'INVALID_BENCHMARK'},{status:error instanceof Error&&error.message==='BODY_LIMIT'?413:400});}
        const result=await env.SOLVER.getByName('synthetic-poc').benchmarkSaved(command);
        return new Response(result.body,{status:result.httpStatus,headers:{'content-type':'application/json','cache-control':'no-store','x-poc-process-stopped':String(result.processStopped)}});
      }
      if(path==='/__poc/optimizer-stop')return Response.json(await env.SOLVER.getByName('synthetic-poc').releaseIdleProbe());
      if(path==='/__poc/optimizer-destroy-idle'){
        if(env.ENVIRONMENT!=='poc')return Response.json({error:'FORBIDDEN'},{status:403});
        const solver=env.SOLVER.getByName('synthetic-poc'),before=await solver.executionState();
        if(before.activeRpc||before.persistedFence)return Response.json({error:'PROBE_BUSY'},{status:409});
        // Private recovery of this single direct-probe object only. An old
        // Durable Object may still execute its previous class after deployment.
        await solver.destroy();
        const after=await solver.executionState();
        return Response.json({released:!after.processRunning,...after});
      }
      if (path === '/__poc/optimizer-health') {
        return await env.SOLVER.getByName('synthetic-poc').fetch(new Request('http://container/health'));
      }
      if (path === '/__poc/optimizer' || path === '/__poc/check') {
        const reader = request.body?.getReader();
        if (!reader) return Response.json({error:'EMPTY_BODY'}, {status:400});
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4_000_000) { await reader.cancel(); return Response.json({error:'BODY_LIMIT'}, {status:413}); }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return await env.SOLVER.getByName('synthetic-poc').fetch(new Request(`http://container/${path === '/__poc/check' ? 'check' : 'solve'}`, {
          method: 'POST', headers: {'content-type':'application/json','content-length':String(size)}, body: bytes,
        }));
      }
      if(path==='/__poc/csv-assets')return Response.json(await runCsvAssetProbes(env),{headers:{'cache-control':'no-store'}});
      if (path === '/__poc/d1') return Response.json({environment:'cloudflare', results:await runD1Probes(env.DB)});
      if (path === '/__poc/auth') return Response.json({environment:'cloudflare', results:await runAuthProbes(env)});
      if (path === '/__poc/product') return Response.json({environment:'cloudflare', results:await runProductProbes(env)});
      if (path === '/__poc/inputs') return Response.json({environment:'cloudflare',...await runInputProbes(env)});
      return Response.json({error:'NOT_FOUND'}, {status:404});
    } catch (error) {
      if(['/__poc/final-fixture','/__poc/final-control','/__poc/final-delivery'].includes(path)){
        const limit=error instanceof Error&&error.message==='BODY_LIMIT';
        return Response.json({error:limit?'BODY_LIMIT':error instanceof ProductError?error.code:error instanceof z.ZodError||error instanceof SyntaxError?'INVALID_INPUT':'PROBE_FAILED'},
          {status:limit?413:error instanceof ProductError?error.status:error instanceof z.ZodError||error instanceof SyntaxError?400:500,headers:{'cache-control':'no-store'}});
      }
      if (error instanceof ResetMailProbeFailure) return Response.json({error:'RESET_MAIL_PROBE_FAILED',providerStatus:error.providerStatus}, {status:502,headers:{'cache-control':'no-store'}});
      return Response.json({error:'PROBE_FAILED'}, {status:500});
    }
  },
  queue:handleJobBatch,
  scheduled:async(_event,env)=>{try{await withMaintenance(env.DB,'BACKGROUND',async()=>{await pruneAuthLimits(env.DB);await recoverDeliveries(env);await cleanupExpiredComputeProbes(env);await cleanupExpiredCancellationProbes(env);});}catch(error){if(!(error instanceof MaintenanceError))throw error;}},
} satisfies ExportedHandler<Cloudflare.PocEnv>;
export default {
 ...pocWorker,
 async fetch(request:Request,env:Env,ctx?:ExecutionContext){
  const path=new URL(request.url).pathname;
  if((['GET','HEAD'].includes(request.method)&&resetPagePaths.has(path))||path==='/__poc/deploy-preflight')return pocWorker.fetch(request,env,ctx);
  if(!(request.method==='POST'&&path==='/api/auth/reset-password')){
   const denied=privatePocAccess(request,env);if(denied)return denied;
  }
  try{return await withMaintenance(env.DB,'FOREGROUND',()=>pocWorker.fetch(request,env,ctx));}
  catch(error){if(error instanceof MaintenanceError)return maintenanceResponse();throw error;}
 },
} satisfies ExportedHandler<Cloudflare.PocEnv>;
