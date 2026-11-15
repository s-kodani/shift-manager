export const fixtures={single:{ownerId:'single-owner',companyId:'single',teamId:'single',month:'2026-10',staffCount:1,staffLogin:{staffId:'single-staff'}},large:{ownerId:'large-owner',companyId:'large',teamId:'large',month:'2026-10',staffCount:101,staffLogin:{staffId:'large-staff'}}};
export const ids={snapshot3:'snapshot-small',snapshot4:'snapshot-large'};
export const keys=['singleAdmin','singleStaff','largeAdmin','largeStaff'];
export function server(){const calls=[];let frozen=false,restored=false,changed=false;return {calls,freeze:v=>frozen=v,restore:()=>restored=true,alter:()=>changed=true,fetch:async(url,o)=>{
 calls.push({url,...o});const route=new URL(url).pathname,body=o.body&&JSON.parse(o.body),cookie=o.headers.cookie;
 if(route==='/api/auth/sign-in/email'){if(frozen)return Response.json({error:'FROZEN'},{status:503});return Response.json({user:{}},{headers:{'set-cookie':'session=new-'+body.email+'; Path=/'}});}
 if(route==='/api/context'){if(frozen)return Response.json({error:'FROZEN'},{status:503});return Response.json({context:true},{status:restored&&!cookie.includes('new-')?401:200});}
 const own=cookie.includes('single')?'single':'large',kind=route.includes('/companies/single/')?'single':'large',staff=cookie.includes('Staff');if(own!==kind||(staff&&route.endsWith('/export')))return Response.json({error:'FORBIDDEN'},{status:403});
 const f=fixtures[kind],publication={publicationRevision:kind==='single'?3:1,publication:{publicationId:'publication-'+kind,assignments:Array.from({length:staff?31:f.staffCount*31},()=>({staffId:f.staffLogin.staffId,date:'2026-10-01'}))}};
 if(route.endsWith('/publications'))return Response.json(publication);
 if(route.endsWith('/export'))return new Response('date,staff\n2026-10-01,fictional\n');
 if(route.endsWith('/planning/2026-10'))return Response.json({version:{payload:{events:[{staffIds:[]}]}}});
 if(route.endsWith('/leave'))return Response.json({records:kind==='single'?[{status:'APPROVED'}]:[]});
 return Response.json({fictional:true,value:changed&&route.endsWith('/fixed')?'different':'stable'});
 }};}
export const credentials=Object.fromEntries(keys.map(key=>[key,{email:key+'@example.invalid',password:'fictional-password-for-recovery-test-only'}]));
export const jar=()=>Object.fromEntries(keys.map(key=>[key,{session:'old-'+key}]));
