// Explicit fictional HTTP/auth acceptance; no schedule, mail or cloud mutation.
import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['scripts/run-cancellation-boundaries.mjs'],{stdio:'inherit',env:{...process.env,NATIVE_LARGE_COMPUTE:'1',NATIVE_HTTP_COMPUTE:'1'}});
child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
