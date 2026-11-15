import {operatorProvision,provisionFingerprint,type OperatorProvision} from '../../../scripts/operator-contract.mjs';
type Database=Pick<D1Database,'prepare'|'batch'>;
type Receipt={id:string;company_id:string;user_id:string;principal:string;fingerprint:string;created_at:number};
export class OperatorError extends Error{
 constructor(public code:string,public status:400|409|500){super(code);}
}
export async function inspectProvision(db:Database,principal:string,id:string){
 const row=await db.prepare('SELECT id,company_id,user_id,principal,fingerprint,created_at FROM operator_provision_operation WHERE id=? AND principal=?').bind(id,principal).first<Receipt>();
 // Always the frozen initial receipt, never the company's current state.
 return row?{found:true as const,operationId:row.id,companyId:row.company_id,userId:row.user_id,initialRevision:0,createdAt:row.created_at,fingerprint:row.fingerprint}:{found:false as const};
}
export async function provisionInitialCompany(db:Database,principal:string,data:OperatorProvision){
 const p=operatorProvision.parse(data),fingerprint=await provisionFingerprint(p);
 const replay=async()=>{
  const old=await inspectProvision(db,principal,p.operationId);
  if(old.found&&old.fingerprint!==fingerprint)throw new OperatorError('OPERATION_ID_CONFLICT',409);
  return old;
 };
 const old=await replay();if(old.found)return {...old,replayed:true};
 const at=Date.now(),iso=new Date(at).toISOString();
 try{
  await db.batch([
   db.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned) VALUES (?,?,?,0,?,?,'user',0)").bind(p.userId,p.adminName,p.adminEmail,iso,iso),
   db.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES (?,?,'credential',?,?,?,?)").bind(p.accountId,p.userId,p.userId,p.passwordHash,iso,iso),
   db.prepare('INSERT INTO access_state(user_id,enabled,must_change_password) VALUES (?,1,1)').bind(p.userId),
   db.prepare('INSERT INTO company(id,name) VALUES (?,?)').bind(p.operationId,p.companyName),
   db.prepare('INSERT INTO company_admin(company_id,user_id) VALUES (?,?)').bind(p.operationId,p.userId),
   db.prepare('INSERT INTO operator_provision_operation(id,company_id,user_id,principal,fingerprint,created_at) VALUES (?,?,?,?,?,?)').bind(p.operationId,p.operationId,p.userId,principal,fingerprint,at),
   db.prepare("INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,NULL,'operator_provision_company',0,?)").bind(p.operationId,p.operationId,at),
  ]);
 }catch(error){
  const concurrent=await replay();if(concurrent.found)return {...concurrent,replayed:true};
  const message=String(error);
  if(message.includes('UNIQUE constraint'))throw new OperatorError('PROVISION_CONFLICT',409);
  if(message.includes('OPERATOR_INVALID_PROVISION')||message.includes('FOREIGN KEY constraint'))throw new OperatorError('INVALID_PROVISION',400);
  throw new OperatorError('PROVISION_UNAVAILABLE',500);
 }
 const receipt=await replay();if(!receipt.found)throw new OperatorError('PROVISION_UNAVAILABLE',500);
 return {...receipt,replayed:false};
}
