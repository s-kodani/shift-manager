import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import worker from '../../apps/api/src/poc-worker';
import {inputFixture} from '../../apps/api/src/input-probes';

const user='fictional-browser',password=crypto.randomUUID()+crypto.randomUUID();
const basic={authorization:'Basic '+Buffer.from(user+':'+password).toString('base64')};
const bindings=()=>({...env,ENVIRONMENT:'poc',BROWSER_BASIC_USER:user,BROWSER_BASIC_PASSWORD:password});
const request=(path:string,headers:Record<string,string>={},body?:unknown)=>new Request(env.AUTH_BASE_URL+path,{
  method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{origin:env.AUTH_BASE_URL,'content-type':'application/json'})},
  body:body===undefined?undefined:JSON.stringify(body),
});
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});

it('challenges the product HTML, assets and API but fails closed without both secrets or outside poc',async()=>{
  for(const path of ['/app','/app-assets/assets/missing.js','/api/context']){
    for(const authorization of ['',basic.authorization+'wrong','Basic invalid','Basic '+ 'a'.repeat(3000)]){
      const r=await worker.fetch(request(path,{authorization}),bindings());
      expect(r.status).toBe(401);expect(r.headers.get('www-authenticate')).toContain('Basic realm=');
      expect(r.headers.get('cache-control')).toBe('no-store');
    }
  }
  for(const b of [{...bindings(),BROWSER_BASIC_USER:''},{...bindings(),BROWSER_BASIC_PASSWORD:''},{...bindings(),ENVIRONMENT:'local'},{...bindings(),ENVIRONMENT:'production'}])
    expect((await worker.fetch(request('/app',basic),b)).status).toBe(403);
});

it('serves actual HTML and JS/CSS after Basic auth, including a case-insensitive scheme',async()=>{
  const page=await worker.fetch(request('/app',{authorization:basic.authorization.replace('Basic','bAsIc')}),bindings());
  expect(page.status).toBe(200);expect(page.headers.get('cache-control')).toBe('no-store');
  const html=await page.text(),assets=[...html.matchAll(/(?:src|href)="(\/app-assets\/assets\/[^\"]+\.(?:js|css))"/g)].map(m=>m[1]);
  expect(assets.length).toBeGreaterThanOrEqual(2);
  for(const asset of assets)expect((await worker.fetch(request(asset,basic),bindings())).status).toBe(200);
  expect((await worker.fetch(request('/api/context',basic),bindings())).status).toBe(401);
  expect((await worker.fetch(request('/api/unknown',basic),bindings())).status).toBe(404);
});

it('never authorizes probes, operator routes or auth provisioning with browser credentials',async()=>{
  const before=await env.DB.prepare('SELECT count(*) AS n FROM user').first('n');
  for(const path of ['/__poc/compute-start','/__poc/final-fixture','/__poc/deploy-preflight','/provision','/inspect','/api/auth/sign-up/email','/api/auth/admin/create-user'])
    expect((await worker.fetch(request(path,basic,{}),bindings())).status).toBe(403);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM user').first('n')).toBe(before);
});

it('keeps legacy Bearer product access independent of Basic configuration',async()=>{
  const r=await worker.fetch(request('/app',{authorization:'Bearer '+env.POC_TOKEN}),{...env,ENVIRONMENT:'poc'});
  expect(r.status).toBe(200);
  expect((await worker.fetch(request('/__poc/deploy-preflight',{},{}),bindings())).status).toBe(403);
});

it('preserves individual login, first-change, origin and company authority behind Basic',async()=>{
  const f=await inputFixture(env.DB);
  await env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id=?').bind(f.company.userId).run();
  const login=await worker.fetch(request('/api/auth/sign-in/email',basic,{email:f.email,password:f.company.initialPassword}),bindings());
  expect(login.status).toBe(200);const cookie=login.headers.get('set-cookie')!.split(';')[0],headers={...basic,cookie};
  const gated=await worker.fetch(request('/api/context',headers),bindings());
  expect(gated.status).toBe(403);expect(await gated.json()).toMatchObject({error:'PASSWORD_CHANGE_REQUIRED'});
  const newPassword=crypto.randomUUID()+crypto.randomUUID();
  const foreign=request('/api/password',headers,{currentPassword:f.company.initialPassword,newPassword});foreign.headers.set('origin','https://foreign.invalid');
  expect((await worker.fetch(foreign,bindings())).status).toBe(403);
  const changed=await worker.fetch(request('/api/password',headers,{currentPassword:f.company.initialPassword,newPassword}),bindings());
  expect(changed.status).toBe(200);const fresh={...basic,cookie:changed.headers.get('set-cookie')!.split(';')[0]};
  expect((await worker.fetch(request('/api/context',fresh),bindings())).status).toBe(200);
  expect((await worker.fetch(request('/api/context',{...fresh,authorization:'Basic wrong'}),bindings())).status).toBe(401);
  expect((await worker.fetch(request(`/api/companies/${crypto.randomUUID()}/teams/${f.team}/staff`,fresh),bindings())).status).toBe(403);
  expect((await worker.fetch(request('/api/auth/sign-out',fresh,{}),bindings())).status).toBe(200);
  expect((await worker.fetch(request('/api/context',fresh),bindings())).status).toBe(401);
});
