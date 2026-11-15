import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,beforeEach,it,expect,vi} from 'vitest';
import {consumeAuthLimit,pruneAuthLimits} from '../../apps/api/src/auth-request-limit';
import {createApp} from '../../apps/api/src/index';
import {createAuth} from '../../apps/api/src/auth';
import {authJson} from '../../apps/api/src/auth-request';

const base=env.AUTH_BASE_URL,headers={origin:base,'content-type':'application/json','cf-connecting-ip':'192.0.2.40'};
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{await env.DB.prepare('DELETE FROM auth_request_limit').run();});
it('one D1 statement permits exactly the budget under concurrent consumers; rejected attempts do not extend the expiry',async()=>{
  const key='fictional:'+crypto.randomUUID(),rule={window:60,max:5},now=Date.UTC(2026,9,11);
  const results=await Promise.all(Array.from({length:32},()=>consumeAuthLimit(env.DB,env.BETTER_AUTH_SECRET,key,rule,now)));
  expect(results.filter(x=>x.allowed)).toHaveLength(5);expect(results.filter(x=>!x.allowed).every(x=>x.retryAfter===60)).toBe(true);
  expect(await consumeAuthLimit(env.DB,env.BETTER_AUTH_SECRET,key,rule,now+59999)).toEqual({allowed:false,retryAfter:1});
  expect(await consumeAuthLimit(env.DB,env.BETTER_AUTH_SECRET,key,rule,now+60000)).toEqual({allowed:true,retryAfter:null});
});
it('stores keyed hashes only; expired cleanup preserves active counters and database failure does not grant access',async()=>{
  const key='email:fictional@example.invalid',now=10000;await consumeAuthLimit(env.DB,env.BETTER_AUTH_SECRET,key,{window:1,max:1},now);await consumeAuthLimit(env.DB,env.BETTER_AUTH_SECRET,'different@example.invalid',{window:60,max:1},now);
  const rows=await env.DB.prepare('SELECT * FROM auth_request_limit').all<{key:string}>();expect(rows.results.every(r=>/^[a-f0-9]{64}$/.test(r.key))).toBe(true);expect(JSON.stringify(rows)).not.toContain('example.invalid');
  await pruneAuthLimits(env.DB,now+1000);expect(await env.DB.prepare('SELECT count(*) n FROM auth_request_limit').first('n')).toBe(1);
  await expect(consumeAuthLimit({prepare(){throw new Error('fictional private database detail');}},env.BETTER_AUTH_SECRET,key,{window:1,max:1})).rejects.toThrow(/^AUTH_LIMIT_UNAVAILABLE$/);
});
it('shared Better Auth IP limit survives new app instances, ignores forwarded-for and normalizes IPv6 /64',async()=>{
  const auth=createAuth(env),h={...headers,'cf-connecting-ip':'2001:db8:1:2::1'};
  await auth.handler(new Request(base+'/api/auth/sign-in/email',{method:'POST',headers:h,body:'{}'}));
  expect(await env.DB.prepare('SELECT count(*) n FROM auth_request_limit').first('n')).toBe(1);
  await env.DB.prepare('UPDATE auth_request_limit SET count=100').run();
  for(const app of [createApp(),createApp()]){
    const r=await app.request(base+'/api/auth/sign-in/email',{method:'POST',headers:{...headers,'cf-connecting-ip':'2001:0db8:0001:0002::abcd','x-forwarded-for':'203.0.113.90'},body:JSON.stringify({email:`fictional-${crypto.randomUUID()}@example.invalid`,password:crypto.randomUUID()})},env);
    expect(r.status).toBe(429);expect(r.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);expect(r.headers.get('cache-control')).toBe('no-store');expect((await r.json() as {error:string}).error).toBe('RATE_LIMITED');
  }
  // Exhausted IP cannot create counters by rotating email identities.
  expect(await env.DB.prepare('SELECT count(*) n FROM auth_request_limit').first('n')).toBe(1);
});
it('reset email budget is case-insensitive across IPs, known and absent accounts return the same acknowledgements and limits',async()=>{
  const email=`fictional-${crypto.randomUUID()}@example.invalid`,auth=createAuth(env),mail=vi.fn<NonNullable<Parameters<typeof createApp>[0]>>().mockResolvedValue(undefined);
  await auth.api.createUser({body:{email,password:crypto.randomUUID(),name:'Fictional reset limiter'}});
  for(const recipient of [email,`absent-${crypto.randomUUID()}@example.invalid`]){
    const statuses=[];
    for(let i=0;i<4;i++){
      const r=await createApp(mail).request(base+'/api/auth/request-password-reset',{method:'POST',headers:{...headers,'cf-connecting-ip':`192.0.2.${50+i}`},body:JSON.stringify({email:i%2?recipient.toUpperCase():recipient})},env);
      statuses.push(r.status);if(i===3){expect(r.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);expect((await r.json() as {error:string}).error).toBe('RATE_LIMITED');}
      else expect(await r.json()).toEqual({status:true,message:'If this email exists in our system, check your email for the reset link'});
    }
    expect(statuses).toEqual([200,200,200,429]);
  }
  expect(mail).toHaveBeenCalledTimes(3);
});
it('auth input rejects oversized chunked bodies, invalid UTF-8, media type, foreign origin and redirect before any mail or counters',async()=>{
  const mail=vi.fn<NonNullable<Parameters<typeof createApp>[0]>>(),app=createApp(mail),url=base+'/api/auth/request-password-reset';
  for(const [h,body,status] of [[{...headers,origin:'https://foreign.invalid'},'{}',403],[{...headers,'content-type':'text/plain'},'{}',415],[headers,'{bad',400],[headers,JSON.stringify({email:'fictional@example.invalid',redirectTo:'https://foreign.invalid/reset'}),400],[headers,JSON.stringify({email:'fictional@example.invalid',unexpected:true}),400],[headers,'x'.repeat(4097),413]] as const){const r=await app.request(url,{method:'POST',headers:h,body},env);expect(r.status).toBe(status);expect(r.headers.get('cache-control')).toBe('no-store');}
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(2048));c.enqueue(new Uint8Array(2049));c.close();}});await expect(authJson(new Request(url,{method:'POST',headers,body:stream}),base)).rejects.toMatchObject({code:'BODY_LIMIT',status:413});
  await expect(authJson(new Request(url,{method:'POST',headers,body:new Uint8Array([0xff])}),base)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(mail).not.toHaveBeenCalled();expect(await env.DB.prepare('SELECT count(*) n FROM auth_request_limit').first('n')).toBe(0);
});
