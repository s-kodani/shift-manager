import {spawn} from 'node:child_process';

// Run the complete existing HTTP acceptance, including both initial and fixed
// calculations, once. Failure is retained; no automatic retry or profile change.
const child=spawn(process.execPath,['scripts/run-cancellation-boundaries.mjs'],{
 stdio:'inherit',env:{...process.env,NATIVE_LARGE_COMPUTE:'1',NATIVE_HTTP_COMPUTE:'1',
  NATIVE_RESOURCE_PROFILE:'standard-2',NATIVE_RESOURCE_SCOPE:'http',NATIVE_FIXTURE_STAFF:'500'},
});
child.on('error',()=>{process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
