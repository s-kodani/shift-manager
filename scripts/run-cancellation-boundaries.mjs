import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {createWriteStream} from 'node:fs';
import { setTimeout } from "node:timers/promises";
import {waitForOwnedContainerRemoval} from './owned-container-cleanup.mjs';
import {nativeResourceProfile,assertResourceLimits,assertNativeSources,cgroupObservationCode} from './native-resource-profile.mjs';

const image = process.env.SECURITY_IMAGE || "shift-planner-cancellation-native";
const largeCompute = process.env.NATIVE_LARGE_COMPUTE === '1';
const registeredCompute = process.env.NATIVE_REGISTERED_COMPUTE === '1';
const httpCompute = process.env.NATIVE_HTTP_COMPUTE === '1';
const savedCandidate = process.env.NATIVE_SAVED_CANDIDATE === '1';
const resources=nativeResourceProfile(process.env);
assert(!savedCandidate || (largeCompute && httpCompute), 'Saved-candidate acceptance requires the explicit HTTP large-compute runner');
const name = "shift-planner-cancellation-" + randomUUID();
const artifact = resources ? `artifacts/bounded-compute-native/${resources.scope}-${resources.staff}-${name}` : savedCandidate ? "artifacts/saved-candidate-native" : httpCompute ? "artifacts/http-compute-native" : registeredCompute ? "artifacts/registered-compute-native" : largeCompute ? "artifacts/large-compute-native" : "artifacts/cancellation-native";
console.log('Native evidence directory: '+artifact);
await fs.mkdir(artifact, { recursive: true });
function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || "Docker command failed");
  return r.stdout.trim();
}
function run(command, args, env = process.env, logPath = null) {
  return new Promise((resolve, reject) => {
    const log=logPath?createWriteStream(logPath,{flags:'wx'}):null;
    const child = spawn(command, args, { stdio: log ? ['inherit','pipe','pipe'] : 'inherit', env });
    if(log){
     child.stdout.on('data',chunk=>{process.stdout.write(chunk);log.write(chunk);});
     child.stderr.on('data',chunk=>{process.stderr.write(chunk);log.write(chunk);});
     log.on('error',error=>{child.kill('SIGTERM');reject(error);});
    }
    const timeout = globalThis.setTimeout(() => child.kill("SIGTERM"), (registeredCompute || httpCompute) ? 720000 : 600000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      log?.end();
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      const finish=()=>code === 0 ? resolve() : reject(Error(command + " exited " + code));
      if(log)log.end(finish);else finish();
    });
  });
}
let created = false,
  testsPassed = false,
  stopped = false;
let sourceHashes=null,inspection=null,finalState=null,fixtureSha256=null,observations=[],observationErrors=[];
const monitorAbort=new AbortController();let monitor=null;
function observe(){
 try{observations.push({at:new Date().toISOString(),...JSON.parse(docker(['exec',name,'python','-c',cgroupObservationCode]))});}
 catch(error){observationErrors.push({at:new Date().toISOString(),error:error.message});}
}
try {
  // CI may reuse its image built from this checkout; local default always builds.
  if (!process.env.SECURITY_IMAGE)
    await run("docker", [
      "build",
      "--platform",
      "linux/amd64",
      "-f",
      "services/optimizer/Dockerfile",
      "-t",
      image,
      ".",
    ]);
  docker([
    "run",
    "--detach",
    ...(resources ? resources.dockerArgs : ["--rm"]),
    "--platform",
    "linux/amd64",
    "--name",
    name,
    "--publish",
    "127.0.0.1::8080",
    image,
  ]);
  created = true;
  if(resources){
   const actual=JSON.parse(docker(['inspect',name]))[0];assertResourceLimits(resources,actual);
   inspection={containerId:actual.Id,imageId:actual.Image,platform:'linux/amd64',
    nanoCpus:actual.HostConfig.NanoCpus,memoryBytes:actual.HostConfig.Memory,memorySwapBytes:actual.HostConfig.MemorySwap};
   observe();
   monitor=(async()=>{while(!monitorAbort.signal.aborted){
    try{await setTimeout(2000,undefined,{signal:monitorAbort.signal});}catch{break;}
    observe();
   }})();
  }
  const port = docker(["port", name, "8080/tcp"]);
  assert.match(port, /^127\.0\.0\.1:\d+$/);
  const base = "http://" + port;
  let healthy = false;
  let healthBody=null;
  for (let n = 0; n < 40; n++) {
    try {
      const r = await fetch(base + "/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) {
        if(resources)healthBody=await r.json();
        healthy = true;
        break;
      }
    } catch {
      /* process startup only; no business mutation has been dispatched */
    }
    await setTimeout(500);
  }
  assert(healthy, "Native checker did not start");
  if(resources)sourceHashes=await assertNativeSources(healthBody);
  const fixture = spawnSync('docker', ['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'python', image, '-m', 'optimizer.checker_fixture',...(resources?['--staff',String(resources.staff)]:[])], {encoding:'utf8',timeout:30000,maxBuffer:20_000_000});
  assert.equal(fixture.status,0,fixture.stderr || 'Cannot generate fictional monthly fixture');
  const fixturePath = artifact + '/large-checker-fixture.json';
  await fs.writeFile(fixturePath,fixture.stdout);
  if(resources){const {createHash}=await import('node:crypto');fixtureSha256=createHash('sha256').update(fixture.stdout).digest('hex');}
  await run(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.native.config.ts",
      "--reporter=default",
      "--reporter=json",
      "--outputFile=" + artifact + "/tests.json",
    ],
    { ...process.env, CANCELLATION_NATIVE_CHECK_URL: base, NATIVE_LARGE_CHECKER_FIXTURE: fixturePath },
    resources?artifact+'/test-output.log':null,
  );
  testsPassed = true;
} finally {
 monitorAbort.abort();if(monitor)await monitor;
 try{
  if (created) {
    if(resources)try{
     const current=JSON.parse(docker(['inspect',name]))[0];
     finalState={running:current.State.Running,oomKilled:current.State.OOMKilled,exitCode:current.State.ExitCode,error:current.State.Error};
     if(current.State.Running)observe();
     await fs.writeFile(artifact+'/container.log',docker(['logs',name])+'\n');
    }catch(error){observationErrors.push({at:new Date().toISOString(),error:error.message});}
    docker(["stop", "--time", "1", name]);
    if(resources)docker(['rm',name]);
    // --rm removes only the owned container. Other developer containers are untouched.
    await waitForOwnedContainerRemoval(()=>docker([
        "ps",
        "-a",
        "--filter",
        "name=^/" + name + "$",
        "--format",
        "{{.ID}}",
      ]));
    stopped = true;
  }
 }finally{
  await fs.writeFile(
    artifact + "/runtime.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        image,
        ...(resources?{resources,inspection,sourceHashes,fixtureSha256,finalState,observations,observationErrors,
         measuredScope:'Docker cgroup quota rehearsal; disk unbounded; not Cloudflare CPU equivalence or real Queues/SDK acceptance'}:{}),
        solveProfile: largeCompute ? (savedCandidate ? 'mvp-joint-seed-v1' : 'mvp-joint-covered-off-hints-v1') : null,
        testsPassed,
        ownedContainerStopped: stopped,
        scope: resources?.scope==='prepared-snapshot' ? `${resources.staff}-person prepared snapshot, real native solve/check, workerd D1/R2/read; controlled transport and termination callback; no registration/auth/browser/real Queues/SDK/cloud acceptance` :
          httpCompute ? "500-person real product HTTP/auth/registration/compiler/consumer/native solve/check/draft/publication/self read; controlled Queue delivery and DO RPC/lifecycle; excludes browser/real Queues/remote acceptance" : registeredCompute ? "500-person business registration functions and compiler, native solve/check, manual draft/fixed recalculation and R2/D1/read; excludes HTTP/auth/browser/Queues, real DO termination and remote acceptance" : largeCompute ? "live 500-person native HTTP solve/check and workerd snapshot fixture/job/R2/D1/read; excludes real input registration, Queues, draft/publication/UI and remote acceptance" : "local workerd D1/R2 business functions with real Docker HTTP independent checker; no remote/cloud browser acceptance",
        emailSent: false,
        backupDispatched: false,
      },
      null,
      2,
    ) + "\n",
  );
 }
}
if(resources){
 assert.equal(observationErrors.length,0,'Resource observations are incomplete; see runtime evidence');
 assert(observations.length>0,'Missing kernel resource observations');
 assert.equal(finalState?.oomKilled,false,'Owned server was killed by OOM');
}
