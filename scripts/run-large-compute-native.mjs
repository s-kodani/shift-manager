// Explicit expensive, fictional native acceptance; no scheduled/remote action.
import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['scripts/run-cancellation-boundaries.mjs'],{stdio:'inherit',env:{...process.env,NATIVE_LARGE_COMPUTE:'1'}});
child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
