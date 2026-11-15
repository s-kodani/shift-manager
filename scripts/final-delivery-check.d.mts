export function verifyFinalDeliveryReceipt(value:unknown,expected:{ownerId:string;operationId:string;jobIds:string[]}):unknown;
export function verifyFinalDelivery(options:{ownerId:string;operationId:string;jobIds:string[];request:(route:string,body:unknown)=>Promise<Response>;record:(value:unknown)=>Promise<unknown>}):Promise<unknown>;
