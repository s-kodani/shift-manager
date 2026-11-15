import {expect,it} from 'vitest';
import {confirmProcessStopped} from '../../apps/api/src/container-lifecycle';

it('a stopped process needs no new destroy request',async()=>{
 let calls=0;await confirmProcessStopped({running:false,destroy:async()=>{calls++;}});expect(calls).toBe(0);
});
it('termination remains pending until destroy completes and running is false',async()=>{
 let release!:()=>void;const stopped=new Promise<void>(r=>{release=r;});
 const container={running:true,destroy:async()=>{await stopped;container.running=false;}};
 let confirmed=false;const result=confirmProcessStopped(container).then(()=>{confirmed=true;});
 await Promise.resolve();expect(confirmed).toBe(false);expect(container.running).toBe(true);
 release();await result;expect(confirmed).toBe(true);expect(container.running).toBe(false);
});
it('an acknowledged destroy with a still-running process is not confirmed',async()=>{
 await expect(confirmProcessStopped({running:true,destroy:async()=>{}})).rejects.toThrow('PROCESS_STOP_UNCONFIRMED');
});
it('a failed destroy is not confirmed',async()=>{
 await expect(confirmProcessStopped({running:true,destroy:async()=>{throw Error('transport unavailable');}})).rejects.toThrow('transport unavailable');
});
it('an unobserved destroy times out instead of releasing the fence',async()=>{
 await expect(confirmProcessStopped({running:true,destroy:()=>new Promise<void>(()=>{})},5)).rejects.toThrow('PROCESS_STOP_UNCONFIRMED');
});
