type Rule = {window:number;max:number};
type Database = Pick<D1Database,'prepare'>;

// Fixed windows start at the first accepted attempt. Rejected attempts do not
// extend a lockout. The check/increment/reset is one SQL statement, not get/set.
export async function consumeAuthLimit(db:Database,secret:string,key:string,rule:Rule,now=Date.now()){
  if(!secret||!Number.isSafeInteger(rule.window)||rule.window<1||rule.window>3600||!Number.isSafeInteger(rule.max)||rule.max<1||rule.max>1000)throw new Error('AUTH_LIMIT_UNAVAILABLE');
  const signing=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=await crypto.subtle.sign('HMAC',signing,new TextEncoder().encode(`auth-limit-v1\0${rule.window}\0${key}`));
  const storedKey=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  let row:{count:number;expires_at:number}|null;
  try{
    row=await db.prepare(`INSERT INTO auth_request_limit(key,count,expires_at) VALUES (?,1,?)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN expires_at<=? THEN 1 ELSE MIN(count+1,?) END,
        expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END
      RETURNING count,expires_at`).bind(storedKey,now+rule.window*1000,now,rule.max+1,now).first<{count:number;expires_at:number}>();
  }catch{throw new Error('AUTH_LIMIT_UNAVAILABLE');}
  if(!row)throw new Error('AUTH_LIMIT_UNAVAILABLE');
  return {allowed:row.count<=rule.max,retryAfter:row.count<=rule.max?null:Math.max(1,Math.ceil((row.expires_at-now)/1000))};
}
export async function pruneAuthLimits(db:Database,now=Date.now()){
  await db.prepare('DELETE FROM auth_request_limit WHERE expires_at<=?').bind(now).run();
}
export function limitedResponse(retryAfter:number){
  return Response.json({error:'RATE_LIMITED',retryAfter},{status:429,headers:{'retry-after':String(retryAfter),'x-retry-after':String(retryAfter),'cache-control':'no-store'}});
}
