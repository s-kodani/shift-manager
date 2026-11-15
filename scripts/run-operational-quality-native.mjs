import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import {assertNativeSources, assertResourceLimits, cgroupObservationCode} from './native-resource-profile.mjs';
import {compareCheckedObjectives} from './quality-comparison.mjs';

const offComparison = process.argv[3] === '--covered-off-comparison';
const repeatComparison = process.argv[3] === '--repeat=2';
const deadlineComparison = process.argv[3] === '--deadline-comparison';
const processComparison = process.argv[3] === '--process-comparison';
const processStop = process.argv[3] === '--process-stop';
const initialOnly = process.argv[3] === '--initial-candidate-500';
const earlyCheckpoint = process.argv[3] === '--early-checkpoint-500';
const splitProcess = process.argv[3] === '--split-process-500';
const common500 = process.argv[3] === '--common-run-500' || initialOnly || earlyCheckpoint || splitProcess;
const commonScale = process.argv[3] === '--common-run-scale' || common500;
const sharedScale = process.argv[3] === '--shared-scale' || commonScale;
const compactScale = process.argv[3] === '--compact-scale' || sharedScale;
const calendarScale = process.argv[3] === '--calendar-scale' || compactScale;
const standardScale = process.argv[3] === '--standard-scale' || calendarScale;
const boundedComparison = deadlineComparison || processComparison || processStop || standardScale;
assert.equal(process.argv.length, offComparison || repeatComparison || boundedComparison ? 4 : 3,
  'Usage: run-operational-quality-native.mjs image-sha256 [--covered-off-comparison|--repeat=2|--deadline-comparison|--process-comparison|--process-stop|--standard-scale|--calendar-scale|--compact-scale|--shared-scale|--common-run-scale|--common-run-500|--initial-candidate-500|--early-checkpoint-500|--split-process-500]');
const image = process.argv[2]; assert.match(image, /^sha256:[a-f0-9]{64}$/);
const runId = randomUUID(), root = `artifacts/operational-quality/${runId}`;
await mkdir(root, {recursive:true,mode:0o700});
const resources = {nanoCpus:1e9,memoryBytes:6*1024**3};
const quota = ['--cpus','1','--memory','6g','--memory-swap','6g'];
const scenarios = processStop || common500 ? [[500,30]] : boundedComparison ? [[101,30],[500,30]] : [[101,60],[101,30],[500,60],[500,30]];
const normal = boundedComparison ? 'mvp-joint-covered-off-hints-v1' : 'mvp-joint-v1';
const candidate = initialOnly ? 'mvp-checked-hint-v1' : splitProcess ? 'mvp-split-process-v1' : earlyCheckpoint ? 'mvp-early-checkpoint-v1' : commonScale ? 'mvp-joint-common-run-v1' : sharedScale ? 'mvp-joint-shared-build-v1' : compactScale ? 'mvp-joint-compact-minutes-v1' : calendarScale ? 'mvp-joint-calendar-roster-v1' : processStop ? 'mvp-joint-process-stop-75-v1' : processComparison || standardScale ? 'mvp-joint-process-budget-v1' : deadlineComparison ? 'mvp-joint-deadline-stop-v1' : 'mvp-joint-covered-off-hints-v1';
const planned = scenarios.flatMap(([staff,slot]) => processStop || standardScale ? [[staff,slot,candidate,1]] : offComparison
  ? [[staff,slot,normal,1],[staff,slot,candidate,1]] : repeatComparison
    ? [[staff,slot,candidate,1],[staff,slot,candidate,2]] : boundedComparison
      ? [[staff,slot,normal,1],[staff,slot,candidate,1]] : [[staff,slot,candidate,1]]);
const normalResults = new Map();
const firstRuns = new Map();
const report = {runId,imageId:image,scope:initialOnly?'fictional checked initial candidate only; global solver NOT_RUN, no optimization acceptance':standardScale?'fictional standard5x10-v1, direct native HTTP, not full SDK/UI acceptance':'fictional operational-v1, direct native HTTP, not full SDK/UI acceptance',
  profile:offComparison?'paired original/covered-off profiles':processComparison?'paired normal/process-budget profiles':deadlineComparison?'paired normal/deadline-stop profiles':candidate,budgetSeconds:initialOnly?90:splitProcess?240:120,resources,plannedCases:planned,
  deadlineMillis:(common500?10:standardScale?20:processStop?8:offComparison?50:repeatComparison?45:30)*60*1000,startedAt:new Date().toISOString(),automaticRetries:0,
  repeatsPerScenario:repeatComparison?2:1,
  cloudflareDeployments:0,cloudflareCalculations:0,cases:[],acceptanceComplete:false};
const deadline = Date.now()+report.deadlineMillis;
const sha = value => createHash('sha256').update(value).digest('hex');
async function save(){await writeFile(`${root}/report.json`,JSON.stringify(report,null,2)+'\n');}
function docker(args){
  const r=spawnSync('docker',['--host','unix:///var/run/docker.sock',...args],
    {encoding:'utf8',timeout:30000,maxBuffer:20_000_000});
  assert.equal(r.status,0,'OWNED_DOCKER_OPERATION_FAILED');return r.stdout.trim();
}
async function json(response,limit){
  const chunks=[];let size=0;const reader=response.body.getReader();
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
    assert(size<=limit,'RESPONSE_LIMIT');chunks.push(value);}}
  catch(error){await reader.cancel();throw error;}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function post(base,route,body,millis,profile=normal){
  assert(deadline>Date.now()+millis,'OVERALL_BUDGET_EXHAUSTED');
  const raw=JSON.stringify(body);assert(Buffer.byteLength(raw)<=16_000_000,'REQUEST_LIMIT');
  const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',
    'X-Optimizer-Profile':profile},body:raw,signal:AbortSignal.timeout(millis)});
  const payload=await json(response,16_000_000);
  if(response.status!==200){
    const error=new Error(`HTTP_${response.status}`);
    if(response.status===500 && payload.error==='MODEL_ERROR' && payload.diagnostics)
      error.diagnostics=payload.diagnostics;
    throw error;
  }
  return payload;
}
function summary(r){return {status:r.status,objectiveOrder:r.objectiveOrder,objective:r.objective,
  objectiveVector:r.objectiveVector,units:r.units,generalShortage:r.generalShortage,
  roleSameShortage:r.roleSameShortage,preferences:r.preferences?.length,violations:r.violations};}
console.log(JSON.stringify({runId,evidence:root,plannedCases:planned}));await save();
assert.equal(docker(['image','inspect',image,'--format','{{.Id}}']),image);
for(const [staff,slot,profile,iteration] of planned){
  const label=profile===normal?'normal':standardScale?'standard5x10':processStop?'process-stop-75':processComparison?'process-budget':deadlineComparison?'deadline-stop':'covered-off';
  const scenarioKey=`${staff}-${slot}`,fileKey=`${scenarioKey}-${label}`+(repeatComparison?`-r${iteration}`:'');
  const name=`shift-quality-${runId}-${fileKey}`,observations=[],observationErrors=[];
  const entry={staff,slotMinutes:slot,profile,iteration,name,solveRequests:0,checkRequests:0,error:null,ownedContainerRemoved:false};
  report.cases.push(entry);await save();let id=null,timer=null;
  function observe(){try{observations.push(JSON.parse(docker(['exec',id,'python','-c',cgroupObservationCode])));}
    catch(error){observationErrors.push(error.message);}}
  try{
    assert(deadline>Date.now()+6*60*1000,'OVERALL_BUDGET_EXHAUSTED');
    id=docker(['create','--platform','linux/amd64','--name',name,...quota,
      '--publish','127.0.0.1::8080',image]);
    const before=JSON.parse(docker(['inspect',id]))[0];
    assert.equal(before.Image,image);assert.equal(before.State.Running,false);
    assert.equal(before.HostConfig.NanoCpus,resources.nanoCpus);
    assert.equal(before.HostConfig.Memory,resources.memoryBytes);assert.equal(before.HostConfig.MemorySwap,resources.memoryBytes);
    entry.beforeStart={id,imageId:before.Image,running:false,nanoCpus:before.HostConfig.NanoCpus,
      memoryBytes:before.HostConfig.Memory,memorySwapBytes:before.HostConfig.MemorySwap};
    docker(['start',id]);assertResourceLimits(resources,JSON.parse(docker(['inspect',id]))[0]);
    const port=docker(['port',id,'8080/tcp']);assert.match(port,/^127\.0\.0\.1:\d+$/);
    const base='http://'+port;let health;
    for(let n=0;n<40;n++){try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(1000)});
      if(r.ok){health=await json(r,100000);break;}}catch{}await setTimeout(500);}
    assert(health,'NATIVE_STARTUP_FAILED');entry.sourceHashes=await assertNativeSources(health);
    // Generation is read-only inside this owned/quota-limited container. No
    // second container, saved candidate or reference hint enters the solver.
    const raw=docker(['exec',id,'python','-c',
      `import json; from optimizer.operational_fixture import ${standardScale?'standard_scale_fixture':'operational_fixture'} as fixture; d,r=fixture(${staff},${slot}); print(json.dumps({'input':d,'reference':r},separators=(',',':')))`]);
    const {input,reference}=JSON.parse(raw);
    assert.equal(input.staff.length,staff);assert.equal(input.slotMinutes,slot);
    assert.equal(reference.length,staff*31);assert.equal(input.mode,'draft');
    assert(Buffer.byteLength(JSON.stringify(input))<=4_000_000,'SOLVER_INPUT_LIMIT');
    entry.inputSha256=sha(JSON.stringify(input));entry.referenceSha256=sha(JSON.stringify(reference));
    entry.features={tasks:input.tasks.length,roles:input.roles.length,roleRequirements:input.roleRequirements.length,
      patterns:input.patterns.length,
      events:input.events.length,locks:input.locks.length,exceptions:input.exceptions.length,
      history:input.history.length,ruleLayers:[...new Set(input.staff.map(s=>s.rules.length))]};
    await writeFile(`${root}/${fileKey}-fixture.json`,raw+'\n',{mode:0o600});
    observe();timer=globalThis.setInterval(observe,2000);
    const referenceAt=Date.now();entry.checkRequests++;
    const ref=await post(base,'/check',{input,assignments:reference},90000);
    entry.referenceCheckMillis=Date.now()-referenceAt;entry.reference=summary(ref);
    assert.equal(ref.status,'VERIFIED','REFERENCE_NOT_VERIFIED');await save();
    console.log(JSON.stringify({staff,slot,profile,phase:'solve-start',referenceVector:ref.objectiveVector}));
    const started=Date.now();if(initialOnly)entry.generationRequests=1;else entry.solveRequests++;await save();
    const result=await post(base,initialOnly?'/initial-candidate':'/solve',input,splitProcess?270000:150000,profile);entry.solveMillis=Date.now()-started;
    entry.resultSha256=sha(JSON.stringify(result));
    await writeFile(`${root}/${fileKey}-result.json`,JSON.stringify(result)+'\n',{mode:0o600});
    entry.result={solverStatus:result.solverStatus,candidateStatus:result.candidateStatus,
      globalSolverStatus:result.globalSolverStatus,validation:summary(result.validation),
      rows:result.assignments?.length??0,metrics:result.metrics,stages:result.stages};
    assert.equal(result.calculationProfile,profile);
    if(initialOnly){
      assert.equal(result.schemaVersion,'initial-candidate-v1');
      assert.equal(result.candidateStatus,'CHECKED');assert.equal(result.globalSolverStatus,'NOT_RUN');
      assert.equal(result.metrics.budgetSeconds,90);assert.equal(result.publication,'BLOCKED_A1');
    }else if(splitProcess){
      assert.equal(result.metrics.budgetSeconds,240);assert.equal(result.metrics.splitProcess,true);
      assert(result.metrics.processStages.every(s=>s.childReaped));
      if(result.candidateStatus==='CHECKED')assert.equal(result.solverStatus,'UNKNOWN');
      else assert(['OPTIMAL','FEASIBLE'].includes(result.solverStatus));
    }else if(earlyCheckpoint){
      assert.equal(result.metrics.budgetSeconds,120);assert.equal(result.metrics.earlyCheckpointEnabled,true);
      assert.equal(result.metrics.processBudget.seconds,120);assert.equal(result.metrics.processBudget.childReaped,true);
      assert.equal(result.metrics.processBudget.parentValidation,'VERIFIED');
      if(result.candidateStatus==='CHECKED'){
        assert.equal(result.solverStatus,'UNKNOWN');assert(['UNKNOWN','NOT_RUN'].includes(result.globalSolverStatus));
        assert.equal(result.publication,'BLOCKED_A1');
      }else assert(['OPTIMAL','FEASIBLE'].includes(result.solverStatus));
    }else{
    assert.equal(result.metrics.budgetSeconds,120);
    assert.equal(result.metrics.initialHintStrategy,'balanced-incumbent-v4');
    assert.equal(result.metrics.coveredOffHintsEnabled,boundedComparison || profile===candidate);
    assert.equal(result.metrics.deadlineStopEnabled,deadlineComparison && profile===candidate);
    if(standardScale)assert.equal(result.metrics.calendarRosterHintsEnabled,calendarScale);
    if(compactScale)assert.equal(result.metrics.compactMinutesEnabled,true);
    if(sharedScale){assert.equal(result.metrics.sharedBuildFactsEnabled,true);assert.equal(result.metrics.buildVariableLimit,3_500_000);}
    if(commonScale)assert.equal(result.metrics.commonRunsEnabled,true);
    if((processComparison || processStop || standardScale) && profile===candidate) {
      assert.equal(result.metrics.processBudget.seconds,processStop?75:120);
      assert.equal(result.metrics.processBudget.childReaped,true);
      assert.equal(result.metrics.processBudget.parentValidation,result.assignments===null?'NOT_RUN':'VERIFIED');
      if(processStop) {
        assert.equal(result.metrics.processBudget.expired,true);
        assert.equal(result.termination,'PROCESS_DEADLINE');
        assert.equal(result.solverStatus,'FEASIBLE');
      }
    }
    assert(['OPTIMAL','FEASIBLE'].includes(result.solverStatus),'NO_FEASIBLE_RESULT');
    }
    assert.equal(result.validation.status,'VERIFIED');assert.equal(result.assignments.length,staff*31);
    const checkingAt=Date.now();entry.checkRequests++;
    const checked=await post(base,'/check',{input,assignments:result.assignments},90000);
    entry.checkMillis=Date.now()-checkingAt;entry.independentCheck=summary(checked);
    assert.equal(checked.status,'VERIFIED');assert.deepEqual(checked.objectiveVector,result.validation.objectiveVector);
    entry.comparison=compareCheckedObjectives(ref,checked);
    if(repeatComparison){
      const first=firstRuns.get(scenarioKey);
      if(!first)firstRuns.set(scenarioKey,{inputSha256:entry.inputSha256,referenceSha256:entry.referenceSha256,checked});
      else{
        assert.equal(entry.inputSha256,first.inputSha256,'REPEAT_INPUT_MISMATCH');
        assert.equal(entry.referenceSha256,first.referenceSha256,'REPEAT_REFERENCE_MISMATCH');
        entry.repeatComparison=compareCheckedObjectives(first.checked,checked);
      }
    }
    if(profile===normal){normalResults.set(scenarioKey,{inputSha256:entry.inputSha256,referenceSha256:entry.referenceSha256,checked});}
    else if(offComparison || (boundedComparison && !processStop && !standardScale)){
      const baseline=normalResults.get(scenarioKey);assert(baseline,'NORMAL_PAIR_MISSING');
      assert.equal(entry.inputSha256,baseline.inputSha256,'PAIRED_INPUT_MISMATCH');
      assert.equal(entry.referenceSha256,baseline.referenceSha256,'PAIRED_REFERENCE_MISMATCH');
      entry.normalComparison=compareCheckedObjectives(baseline.checked,checked);
    }
    console.log(JSON.stringify({staff,slot,profile,phase:'checked-result',solveMillis:entry.solveMillis,
      iteration,checkMillis:entry.checkMillis,comparison:entry.comparison,normalComparison:entry.normalComparison,repeatComparison:entry.repeatComparison}));
  }catch(error){entry.error=error.message;if(error.diagnostics)entry.failureDiagnostics=error.diagnostics;process.exitCode=1;}
  finally{
    if(timer)globalThis.clearInterval(timer);
    if(!id){const found=docker(['ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}']);
      assert(!found.includes('\n'),'OWNED_CONTAINER_AMBIGUOUS');if(found)id=found;}
    if(id){const state=JSON.parse(docker(['inspect',id]))[0];assert.equal(state.Image,image);assert.equal(state.Name,'/'+name);
      if(state.State.Running)observe();entry.beforeStop={running:state.State.Running,oomKilled:state.State.OOMKilled};
      docker(['stop','--time','1',id]);docker(['rm',id]);
      assert.equal(docker(['ps','-a','--filter','id='+id,'--format','{{.ID}}']),'');entry.ownedContainerRemoved=true;}
    entry.observations=observations;entry.observationErrors=observationErrors;
    entry.kernelPeakBytes=Math.max(0,...observations.map(o=>o.memoryPeakBytes));
    if(observationErrors.length||!observations.length||observations.some(o=>o.memoryMax!==String(resources.memoryBytes)||
      o.cpuMax!=='100000 100000'||o.memoryEvents.oom||o.memoryEvents.oom_kill)||entry.beforeStop?.oomKilled){
      entry.error??='RESOURCE_OBSERVATION_FAILED';process.exitCode=1;}
    await save();
  }
  if(entry.error)break;
}
report.endedAt=new Date().toISOString();report.completedCases=report.cases.filter(c=>c.comparison).length;
report.allPlannedValid=report.completedCases===planned.length&&report.cases.every(c=>!c.error&&c.ownedContainerRemoved);
if(repeatComparison)report.repeatSummary=scenarios.map(([staff,slot])=>{
  const runs=report.cases.filter(c=>c.staff===staff&&c.slotMinutes===slot);
  return {staff,slotMinutes:slot,completed:runs.filter(c=>c.independentCheck).length,
    relation:runs[1]?.repeatComparison?.relation??'NOT_COMPARED',vectors:runs.map(c=>c.independentCheck?.objectiveVector??null),
    solveMillis:runs.map(c=>c.solveMillis??null),checkMillis:runs.map(c=>c.checkMillis??null),
    kernelPeakBytes:runs.map(c=>c.kernelPeakBytes),ownedContainersRemoved:runs.every(c=>c.ownedContainerRemoved)};
});
await save();console.log(JSON.stringify({evidence:root+'/report.json',completedCases:report.completedCases,
  allPlannedValid:report.allPlannedValid,comparisons:report.cases.map(c=>c.comparison?.relation??'NOT_COMPARED'),
  ended:report.cases.every(c=>c.ownedContainerRemoved),acceptanceComplete:false}));
