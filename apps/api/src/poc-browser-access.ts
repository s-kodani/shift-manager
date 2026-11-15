import {createHash,timingSafeEqual} from 'node:crypto';

const authMethods:Record<string,string>={
  '/api/auth/sign-in/email':'POST',
  '/api/auth/sign-out':'POST',
  '/api/auth/get-session':'GET',
  '/api/auth/request-password-reset':'POST',
};
// Basic credentials authorize the product surface only, never PoC probes or
// operator endpoints. The product router still enforces its own live session.
export function browserProductRequest(request:Request){
  const path=new URL(request.url).pathname;
  if(['GET','HEAD'].includes(request.method)&&(path==='/app'||path.startsWith('/app-assets/')))return true;
  if(path.startsWith('/api/auth/'))return authMethods[path]===request.method;
  return path.startsWith('/api/');
}
export function basicBrowserAccess(request:Request,env:Pick<Env,'ENVIRONMENT'|'BROWSER_BASIC_USER'|'BROWSER_BASIC_PASSWORD'>):Response|null{
  const user=env.BROWSER_BASIC_USER,password=env.BROWSER_BASIC_PASSWORD;
  if(env.ENVIRONMENT!=='poc'||!user||!password||user.includes(':')||user.length>128||password.length>512)
    return Response.json({error:'FORBIDDEN'},{status:403,headers:{'cache-control':'no-store'}});
  const authorization=request.headers.get('authorization')??'';
  const expected='Basic '+Buffer.from(user+':'+password,'utf8').toString('base64');
  // Fixed-length digests avoid a secret-length-dependent early comparison.
  const hash=(value:string)=>createHash('sha256').update(value).digest();
  if(authorization.length<=2048&&timingSafeEqual(hash(authorization.replace(/^basic /i,'Basic ')),hash(expected)))return null;
  return Response.json({error:'BASIC_AUTH_REQUIRED'},{status:401,headers:{
    'www-authenticate':'Basic realm="Shift Planner", charset="UTF-8"',
    'cache-control':'no-store',
  }});
}
export function privatePocAccess(request:Request,env:Pick<Env,'ENVIRONMENT'|'BROWSER_BASIC_USER'|'BROWSER_BASIC_PASSWORD'|'POC_TOKEN'>):Response|null{
  const hash=(value:string)=>createHash('sha256').update(value).digest();
  const authorization=request.headers.get('authorization')??'';
  if(env.POC_TOKEN&&authorization.length<=2048&&timingSafeEqual(hash(authorization),hash('Bearer '+env.POC_TOKEN)))return null;
  if(browserProductRequest(request))return basicBrowserAccess(request,env);
  return Response.json({error:'FORBIDDEN'},{status:403,headers:{'cache-control':'no-store'}});
}
