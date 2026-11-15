import {z} from 'zod';

export const preflightReport=z.object({schema:z.literal('poc-deploy-preflight-v1'),observedAt:z.string().datetime(),ready:z.boolean(),
 activeJobs:z.number().int().nonnegative(),activeRevalidations:z.number().int().nonnegative(),checkedObjects:z.number().int().nonnegative(),
 busyObjects:z.number().int().nonnegative(),inventoryStable:z.boolean()}).strict();
export async function boundedPreflight(response){
 if(response.status!==200){await response.body?.cancel();throw Error('PREFLIGHT_HTTP_REJECTED');}
 const reader=response.body?.getReader();if(!reader)throw Error('PREFLIGHT_INVALID');
 const chunks=[];let size=0;
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>16_384){await reader.cancel();throw Error('PREFLIGHT_BODY_LIMIT');}chunks.push(value);}
 try{return preflightReport.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));}
 catch{throw Error('PREFLIGHT_INVALID');}
}
export async function guardedPocDeploy({build,inspect,deploy,record}){
 // Reject an initial failure before building, and recheck after the local build.
 // No response/error text or credentials are echoed on failures.
 for(const phase of ['before-build','before-deploy']){
  let report;try{report=preflightReport.parse(await inspect());}catch{throw Error('PREFLIGHT_UNCONFIRMED');}
  await record(phase,report);
  assertPocDeployReady(report);
  if(phase==='before-build')await build();
 }
 await deploy();
}
export function assertPocDeployReady(value){
 const report=preflightReport.parse(value);
 if(!report.ready||report.activeJobs||report.activeRevalidations||report.busyObjects||!report.inventoryStable||report.checkedObjects<1)throw Error('PREFLIGHT_BUSY_OR_UNCONFIRMED');
 const age=Date.now()-Date.parse(report.observedAt);if(age< -5_000||age>30_000)throw Error('PREFLIGHT_EXPIRED');return report;
}
