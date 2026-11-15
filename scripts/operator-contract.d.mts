import type {z} from 'zod';
export type OperatorDetails={companyName:string;adminName:string;adminEmail:string};
export type OperatorProvision=OperatorDetails&{operationId:string;userId:string;accountId:string;passwordHash:string};
export const operatorDetails:z.ZodType<OperatorDetails>;
export const operatorProvision:z.ZodType<OperatorProvision>;
export const operatorInspect:z.ZodType<{operationId:string}>;
export type OperatorReceipt={found:true;operationId:string;companyId:string;userId:string;initialRevision:0;createdAt:number;fingerprint:string;replayed?:boolean};
export const operatorReceipt:z.ZodType<OperatorReceipt>;
export function provisionFingerprint(input:OperatorProvision):Promise<string>;
