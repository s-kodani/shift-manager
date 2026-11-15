import {z} from 'zod';
const label=z.string().trim().min(1).max(120);
export const operatorDetails=z.object({companyName:label,adminName:label,adminEmail:z.email().max(254).transform(x=>x.toLowerCase())}).strict();
export const operatorProvision=operatorDetails.extend({
  operationId:z.string().uuid(),userId:z.string().uuid(),accountId:z.string().uuid(),
  // Better Auth 1.7.7 native scrypt encoding. Upgrade with compatibility tests.
  passwordHash:z.string().regex(/^[0-9a-f]{32}:[0-9a-f]{128}$/),
}).strict();
export const operatorInspect=z.object({operationId:z.string().uuid()}).strict();
export const operatorReceipt=z.object({found:z.literal(true),operationId:z.string().uuid(),companyId:z.string().uuid(),userId:z.string().uuid(),initialRevision:z.literal(0),createdAt:z.number().int().nonnegative(),fingerprint:z.string().regex(/^[0-9a-f]{64}$/),replayed:z.boolean().optional()}).strict();
export async function provisionFingerprint(input){
  const p=operatorProvision.parse(input);
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({version:'operator-provision-v1',...p})));
  return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
}
