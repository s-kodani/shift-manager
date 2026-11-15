import {spawn} from 'node:child_process';

// Two different sizes, one solve each. A failed case is retained and stops the
// sequence; this command never retries an UNKNOWN/error result automatically.
for(const staff of ['101','500']){
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['scripts/run-cancellation-boundaries.mjs'],{stdio:'inherit',env:{...process.env,
   NATIVE_LARGE_COMPUTE:'1',NATIVE_RESOURCE_PROFILE:'standard-2',NATIVE_FIXTURE_STAFF:staff}});
  child.on('error',reject);child.on('exit',code=>resolve(code??1));
 });
 if(code!==0){process.exitCode=code;break;}
}
