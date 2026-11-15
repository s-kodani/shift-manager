import { z } from 'zod';
import { ProductError } from './product';
import { readExplanation,generateExplanation,workersSummaryProvider,EXPLANATION_MODEL } from './explanations';
export const explanationProbeCommand=z.discriminatedUnion('action',[
  z.object({action:z.literal('read'),probeId:z.string().uuid()}).strict(),
  z.object({action:z.literal('generate'),probeId:z.string().uuid(),operationId:z.string().uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export async function explainOwnedComputeProbe(env:Env,raw:z.infer<typeof explanationProbeCommand>){
  const c=explanationProbeCommand.parse(raw);if(env.ENVIRONMENT!=='poc')throw new ProductError('FORBIDDEN',403);
  const owner=await env.DB.prepare('SELECT company_id,team_id,admin_user_id,cleaned_at,expires_at FROM compute_probe WHERE id=?').bind(c.probeId).first<{company_id:string;team_id:string;admin_user_id:string;cleaned_at:number|null;expires_at:number}>();
  if(!owner)throw new ProductError('NOT_FOUND',404);
  if(owner.cleaned_at!==null||owner.expires_at<=Date.now())throw new ProductError('FORBIDDEN',403);
  const source={kind:'job' as const,id:c.probeId};
  return c.action==='read'?readExplanation(env,owner.company_id,owner.team_id,owner.admin_user_id,source):generateExplanation(env,owner.company_id,owner.team_id,owner.admin_user_id,{operationId:c.operationId,digest:c.digest,source},env.AI_EXPLANATIONS==='workers-ai'&&env.AI?workersSummaryProvider((request,signal)=>env.AI!.run(EXPLANATION_MODEL,request,{signal})):undefined);
}
