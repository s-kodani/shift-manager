import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';

// A Docker quota rehearsal, not a simulation of Cloudflare CPU speed or disk.
export function nativeResourceProfile(env){
 if(!env.NATIVE_RESOURCE_PROFILE){
  assert(!env.NATIVE_FIXTURE_STAFF,'Fixture size requires the explicit bounded runner');
  assert(!env.NATIVE_RESOURCE_SCOPE,'Resource scope requires the explicit bounded runner');
  return null;
 }
 assert.equal(env.NATIVE_RESOURCE_PROFILE,'standard-2','Unsupported resource profile');
 assert.equal(env.NATIVE_LARGE_COMPUTE,'1','Bounded resources require native large compute');
 const scope=env.NATIVE_RESOURCE_SCOPE??'prepared-snapshot';
 assert(['prepared-snapshot','http','registered'].includes(scope),'Unsupported bounded acceptance scope');
 assert.equal(env.NATIVE_HTTP_COMPUTE==='1',scope==='http','Resource scope must match the HTTP test mode');
 assert.equal(env.NATIVE_REGISTERED_COMPUTE==='1',scope==='registered','Resource scope must match the registration test mode');
 assert.notEqual(env.NATIVE_SAVED_CANDIDATE,'1','Saved-candidate profile requires a separate bounded acceptance');
 const staff=env.NATIVE_FIXTURE_STAFF??'500';
 assert(['101','500'].includes(staff),'Bounded fixture must contain 101 or 500 staff');
 assert(scope==='prepared-snapshot'||staff==='500','Registered acceptance requires its full 500-person fixture');
 return {name:'standard-2',scope,staff:Number(staff),nanoCpus:1_000_000_000,memoryBytes:6*1024**3,
  dockerArgs:['--cpus','1','--memory','6g','--memory-swap','6g'],diskLimited:false};
}

export function assertResourceLimits(profile,inspection){
 const config=inspection.HostConfig;
 assert.equal(config.NanoCpus,profile.nanoCpus,'CPU limit was not applied');
 assert.equal(config.Memory,profile.memoryBytes,'Memory limit was not applied');
 assert.equal(config.MemorySwap,profile.memoryBytes,'Swap must not hide memory exhaustion');
 assert.equal(inspection.State.Running,true,'Owned server is not running');
}

export async function assertNativeSources(health,root='services/optimizer/optimizer'){
 const files=(await fs.readdir(root)).filter(f=>f.endsWith('.py')).sort();
 const hashes=Object.fromEntries(await Promise.all(files.map(async file=>[file,
  createHash('sha256').update(await fs.readFile(root+'/'+file)).digest('hex')])));
 assert.deepEqual(health.sourceSha256,hashes,'Native image differs from current Python sources');
 assert.equal(health.runtime?.uid,65534,'Expected the nonroot optimizer runtime');
 assert.equal(health.runtime?.hasShell,false,'Expected the minimal shell-free runtime');
 return hashes;
}

// Read kernel counters, not rounded docker-stats text; a missing counter is an
// observation error. memory.peak is the cgroup high-water mark including cache.
export const cgroupObservationCode=`import json
from pathlib import Path
p=Path('/sys/fs/cgroup')
def pairs(name):
 return {k:int(v) for k,v in (line.split() for line in (p/name).read_text().splitlines())}
print(json.dumps({'memoryCurrentBytes':int((p/'memory.current').read_text()),
 'memoryPeakBytes':int((p/'memory.peak').read_text()),'memoryMax':(p/'memory.max').read_text().strip(),
 'cpuMax':(p/'cpu.max').read_text().strip(),'cpuStat':pairs('cpu.stat'),
 'memoryEvents':pairs('memory.events')}))`;
