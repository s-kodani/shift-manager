import {z} from 'zod';
import {ProductError} from './product';
import type {InputDatabase} from './input-versions';
import type {JobMessage} from './compute-jobs';

export const faultCommand=z.object({operationId:z.string().uuid(),probeId:z.string().uuid(),expectedAttempt:z.number().int().min(1).max(3),mode:z.enum(['restart','crash'])}).strict();
export type FaultCommand=z.infer<typeof faultCommand>;
export type FaultEvidence={id:string;probe_id:string;attempt:number;mode:'restart'|'crash';before_boot:string;requested_at:number;after_boot:string|null;after_process_running:number|null;observed_at:number|null;recovery_boot:string|null;recovery_stopped_at:number|null};
export async function authorizeFault(db:InputDatabase,environment:string,message:JobMessage,command:FaultCommand,now=Date.now()) {
 if(environment!=='poc'||message.jobId!==command.probeId)throw new ProductError('FORBIDDEN',403);
 const owned=await db.prepare(`SELECT 1 FROM compute_probe p JOIN compute_job j ON j.company_id=p.company_id AND j.id=p.id
  WHERE p.id=? AND p.company_id=? AND p.team_id=? AND p.cleaned_at IS NULL AND p.expires_at>?
  AND j.state='RUNNING' AND j.attempt=?`).bind(command.probeId,message.companyId,message.teamId,now,command.expectedAttempt).first();
 if(!owned)throw new ProductError('FAULT_NOT_ALLOWED',409);
}
export async function faultEvidence(db:InputDatabase,command:FaultCommand) {
 const row=await db.prepare('SELECT * FROM compute_fault_probe WHERE id=?').bind(command.operationId).first<FaultEvidence>();
 if(row&&(row.probe_id!==command.probeId||row.attempt!==command.expectedAttempt||row.mode!==command.mode))throw new ProductError('OPERATION_ID_CONFLICT');
 return row;
}
