// A stop request is not evidence of termination. Retain the job fence on any
// error/timeout or if the runtime still reports a running process.
export async function confirmProcessStopped(container:Pick<Container,'running'|'destroy'>,timeoutMs=10_000){
 if(!container.running)return;
 let timeout:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([container.destroy(),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('PROCESS_STOP_UNCONFIRMED')),timeoutMs);})]);
 }finally{if(timeout!==undefined)clearTimeout(timeout);}
 if(container.running)throw new Error('PROCESS_STOP_UNCONFIRMED');
}
