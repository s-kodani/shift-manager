export type FinalD1Receipt={schema:'final-d1-probe-v1';operationId:string;state:'RUNNING'|'COMPLETE'|'FAILED';results:{case:string;passed:boolean}[];remainingRows:number;createdAt:number;finishedAt:number|null};
export const FINAL_D1_CASES:readonly string[];
export function verifyD1Receipt(value:unknown,operationId:string):FinalD1Receipt;
export function inspectFinalD1(operationId:string,request:(route:string,body:object,options?:{withoutToken?:boolean})=>Promise<Response>):Promise<FinalD1Receipt>;
export function verifyFinalD1(args:{operationId:string;request:(route:string,body:object,options?:{withoutToken?:boolean})=>Promise<Response>;record:(value:Record<string,unknown>)=>Promise<void>}):Promise<Record<string,unknown>>;
