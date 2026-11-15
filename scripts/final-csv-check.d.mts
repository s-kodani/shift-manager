export function verifyFinalCsv(options:{
 fixture:{companyId:string;teamId:string;month:string};operationId:string;
 request:(route:string,body?:object,options?:{expected?:number;staff?:boolean})=>Promise<unknown>;
 record:(value:object)=>Promise<void>;
}):Promise<{
 stage:string;operationId:string;month:string;validRows:number;rejectedRows:number;
 previewAbortUnchanged:boolean;directZero:number;unsetDirect:null;scaledCalculated:number[];
 staffPreviewStatus:number;revision:number;applyPosts:number;receiptInspected:boolean;currentMonthVersionUnchanged:boolean;
}>;
