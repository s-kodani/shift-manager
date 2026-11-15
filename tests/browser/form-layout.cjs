async(page,owner)=>{
 const {id,input,base,output,mode,baseline=false,reset,cloud=false}=owner,check=(v,c)=>{if(!v)throw Error(c);};
 const button=n=>page.getByRole('button',{name:n,exact:true});
 const errors=[],writes=[],unknown=[],results=[],screenshots=[];let requests=0,step='init',access='company_admin';try{
 const rule={dailyMax:480,weeklyMax:2400,monthlyMin:60,monthlyMax:12000,minDays:1,minOff:4,maxConsecutive:6};
 const policy={rule,contract:{weekdays:[0,1,2,3,4,5,6],start:480,end:1200},skillLevels:[{level:1,name:'標準'},{level:2,name:'熟練'}],breakRule:{basis:'elapsed',threshold:360,requiredMinutes:60,afterStart:120,beforeEnd:60}};
 const config={slotMinutes:input.slotMinutes,priority:input.priority,capacityScale:input.capacityScale,patterns:input.patterns,tasks:input.tasks.map(t=>({...t,capacities:[{level:1,capacity:60},{level:2,capacity:90}]})),roles:input.roles,transitions:input.transitions,rolePolicies:[{taskId:null,priority:'first'}]};
 const employment='77777777-7777-4777-8777-777777777777';
 page.removeAllListeners('dialog');page.on('dialog',d=>d.accept());await page.unrouteAll({behavior:'wait'});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url()),p=u.pathname;requests++;
  if(u.origin!==base||requests>600){unknown.push(p);await route.abort();return;}
  if(r.method()!=='GET'){writes.push(p);await route.abort();return;}
  if(!cloud&&(p==='/reset'||p==='/reset.css'||p==='/reset.browser.js')){
   await route.fulfill({status:200,contentType:p==='/reset'?'text/html':p.endsWith('.css')?'text/css':'text/javascript',body:p==='/reset'?reset.html:p.endsWith('.css')?reset.css:reset.js});return;
  }
  if(!p.startsWith('/api/')){await route.continue();return;}
  if(p==='/api/access'&&access==='anonymous'){await route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'UNAUTHENTICATED'})});return;}
  let body;
  if(p==='/api/access')body={userId:'synthetic-admin',mustChange:access==='password-change'};
  else if(p==='/api/context')body={userId:'synthetic-admin',companies:[{id:id.company,name:'フォーム幅確認用の架空企業',revision:1,role:access,teams:[{id:id.team,name:'架空チーム',role:access==='company_admin'?null:access,staff_id:id.staff[0]}]}]};
  else if(p.endsWith('/staff'))body={staff:id.staff.map((person,i)=>({id:person,name:'架空スタッフ'+(i+1),staff_number:'000'+(i+1),user_id:'synthetic-'+i,role:'staff',status:'active'}))};
  else if(p.includes('/readiness/'))body={companyId:p.split('/')[3],teamId:p.split('/')[6],month:p.split('/').pop(),inputRevision:1,draftRevision:0,canCompute:true,items:['calendar','company_policy','team_config','staff','contracts','planning','consistency','history','preferences'].map(key=>({id:key,status:'complete',required:!['history','preferences'].includes(key),message:'確認済み',section:'schedule'}))};
  else if(p.endsWith('/jobs'))body={jobs:[]};
  else if(p.endsWith('/drafts'))body={draftRevision:0,draft:null};
  else if(p.endsWith('/publications/history'))body={versions:[],nextCursor:null};
  else if(p.endsWith('/publications/notices'))body={notices:[],nextCursor:null};
  else if(p.endsWith('/publications'))body={publicationRevision:0,publication:null};
  else if(p.includes('/config/'))body={version:{id:'synthetic-config',effectiveFrom:'2026-10',revision:1,payload:config}};
  else if(p.includes('/planning/'))body={version:{id:'synthetic-plan',effectiveFrom:'2026-10',revision:1,payload:{demand:[{date:'2026-10-01',start:540,end:600,taskId:input.tasks[0].id,direct:60,calculated:null}],events:[{id:'fixture-event',date:'2026-10-02',start:600,end:630,kind:'training',staffIds:[id.staff[0]]}],roleRequirements:[{id:'fixture-role',date:'2026-10-01',start:540,end:600,taskId:null,roleId:input.roles[0].id,minimum:1,ratioNumerator:0,ratioDenominator:1}]}}};
  else if(p.includes('/calendar-settings/'))body={version:{settings:{weekStart:0,deadlineDay:20,halfDayDivider:720,roleRounding:'ceil'}}};
  else if(p.includes('/company-policy/'))body={version:{id:'synthetic-policy',effectiveFrom:'2026-10',revision:1,payload:policy}};
  else if(p.includes('/contract-options/'))body={revision:1,policy,employment:[{id:employment,version:employment,effectiveFrom:'2026-10',revision:1,payload:{name:'架空雇用区分',rule,contract:policy.contract}}],roleRounding:'ceil'};
  else if(p.includes('/contract/'))body={version:{id:'synthetic-contract',effectiveFrom:'2026-10',revision:1,payload:{employmentTypeId:employment,contract:policy.contract,rule:null,skills:input.staff[0].skills.map(s=>({taskId:s.taskId,level:s.level})),roleIds:[]}}};
  else if(p.includes('/self-month/'))body={month:'2026-10',revision:1,staffId:id.staff[0],calendarId:id.company,serverTime:1,deadline:{month:'2026-10',configuredDay:20,deadlineDate:'2026-09-20',timeZone:'Asia/Tokyo',closesAt:1},window:null,accepting:true,version:{id:id.staff[0],revision:1,payload:{unavailable:[{date:'2026-10-01',start:607,end:617}],preferences:[{date:'2026-10-01',kind:'window',start:600,end:1020}]}},patterns:input.patterns};
  else if(p.includes('/submission-window/'))body={month:'2026-10',serverTime:1,window:null,deadline:{month:'2026-10',configuredDay:20,deadlineDate:'2026-09-20',timeZone:'Asia/Tokyo',closesAt:1}};
  else if(p.includes('/history/'))body={month:'2026-10',inputRevision:1,window:{first:'2026-10-01',last:'2026-10-31',previousFrom:'2026-08-31',nextThrough:'2026-12-01'},records:[],required:[{staffId:id.staff[0],date:'2026-09-30'}],missing:[{staffId:id.staff[0],date:'2026-09-30'}]};
  else if(p.endsWith('/leave/context'))body={publicationId:id.snapshot,publicationRevision:1,halfDayDivider:720,staff:id.staff.map(person=>({id:person,name:'架空スタッフ',staffNumber:'0001'})),assignments:[]};
  else if(p.endsWith('/leave')||p.endsWith('/leave/notices'))body=p.endsWith('/notices')?{notices:[],nextCursor:null}:{records:[],nextCursor:null};
  else{unknown.push(p);await route.abort();return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });


 const issues=[];
 const ready=async name=>{await page.getByRole('heading',{name,exact:true,level:1}).waitFor();await page.waitForFunction(()=>!document.querySelector('.topbar button')?.disabled&&document.querySelectorAll('[data-slot=loading][aria-busy=true]').length===0);};
 const audit=async(screen,width,iosTheme=false)=>{
  await page.setViewportSize({width,height:900});
  const measured=await page.evaluate(({iosTheme})=>{
   // macOS WebKit device emulation does not load RenderThemeIOS. Reproduce its
   // content-box adjustment only while a date/month control has native appearance.
   // https://github.com/WebKit/WebKit/blob/main/Source/WebCore/rendering/ios/RenderThemeIOS.mm
   if(iosTheme)for(const e of document.querySelectorAll('input[type=date],input[type=month]')){
    if(getComputedStyle(e).appearance!=='none'){e.style.boxSizing='content-box';e.dataset.iosTheme='simulated';}
   }
   const problems=[],controls=[...document.querySelectorAll('input,select,textarea,button')].filter(e=>e.getClientRects().length);
   for(const e of controls){
    if(e.closest('.table-scroll'))continue;
    const r=e.getBoundingClientRect();
    const name=e.getAttribute('aria-label')||e.labels?.[0]?.textContent||e.textContent?.trim().slice(0,80)||e.type;
   const parents=[e.parentElement,e.closest('.field'),e.closest('.panel-body,.auth-card,.published-day,.setup-row,.card')].filter(Boolean);
    for(const p of new Set(parents)){
     const b=p.getBoundingClientRect(),s=getComputedStyle(p),left=b.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft),right=b.right-parseFloat(s.borderRightWidth)-parseFloat(s.paddingRight);
     if(r.left<left-1||r.right>right+1)problems.push({name,type:e.type,parent:p.className,left:r.left-left,right:r.right-right});
    }
   }
   if(document.documentElement.scrollWidth>innerWidth)problems.push({pageWidth:document.documentElement.scrollWidth,viewport:innerWidth});
   return{controls:controls.length,dates:controls.filter(e=>['date','month'].includes(e.type)).length,problems};
  },{iosTheme});
  results.push({screen,width,iosTheme,...measured});
  issues.push(...measured.problems.map(p=>({screen,width,iosTheme,...p})));
  if((screen==='demand'||screen==='company'||screen==='submission')&&(width===320||width===390||width===1280)&&!iosTheme){
   const file=output+'/'+screen+'-'+width+'.png';
   if(screen==='demand')await page.getByRole('region',{name:'需要の一括入力',exact:true}).screenshot({path:file});else await page.screenshot({path:file,fullPage:true});
   screenshots.push(file);
  }
  if(iosTheme)await page.locator('[data-ios-theme]').evaluateAll(es=>es.forEach(e=>{e.style.removeProperty('box-sizing');delete e.dataset.iosTheme;}));
 };
 const sections=[['demand','需要管理'],['history','勤務履歴'],['leave','休暇・欠勤'],['submission','勤務不可・希望'],['team','チーム設定'],['staff','スタッフ管理'],['company','企業共通ルール'],['schedule','シフト・計算結果']];
 for(const[key,name]of sections){
  step=key;await page.goto(base+'/app?month=2026-10&section='+key);await ready(name);
  // Opening existing disclosures makes nested forms part of the audit.
  await page.locator('details').evaluateAll(es=>es.forEach(e=>e.open=true));
  for(const width of [1280,1024,768,700,390,320]){await audit(key,width);await audit(key,width,true);}
 }
 step='staff';access='staff';
 for(const[key,name]of [['submission','勤務不可・希望'],['leave','休暇・欠勤'],['schedule','自分のシフト']]){
  await page.goto(base+'/app?month=2026-10&section='+key);await ready(name);
  await page.locator('details').evaluateAll(es=>es.forEach(e=>e.open=true));
  for(const width of [1280,390,320]){await audit('staff-'+key,width);await audit('staff-'+key,width,true);}
 }
 // Check the reported dates still use native date semantics, bounds and editing.
 access='company_admin';await page.goto(base+'/app?month=2026-10&section=demand');await ready('需要管理');
 await button('期間を指定して必要人数の一括入力').click();
 const start=page.getByLabel('一括入力 開始日',{exact:true});await start.fill('2026-10-02');
 check(await start.inputValue()==='2026-10-02'&&await start.getAttribute('type')==='date','DATE_EDIT');
 check(await start.getAttribute('min')==='2026-10-01'&&await start.getAttribute('max')==='2026-10-31','DATE_BOUNDS');
 await start.focus();await page.keyboard.press('Tab');
 check(await page.evaluate(()=>document.activeElement?.tagName==='INPUT'),'DATE_KEYBOARD');
 step='auth';access='anonymous';await page.goto(base+'/app');await page.getByRole('heading',{name:'ログイン',exact:true}).waitFor();
 for(const width of [1280,390,320])await audit('login',width);
 await button('パスワードをお忘れですか？').click();await page.getByRole('heading',{name:'パスワードを再設定',exact:true}).waitFor();
 for(const width of [1280,390,320])await audit('reset-request',width);
 access='password-change';await page.goto(base+'/app');await page.getByRole('heading',{name:'初回パスワードの変更',exact:true}).waitFor();
 for(const width of [1280,390,320])await audit('password-change',width);
 step='public-reset';await page.goto(base+'/reset#token=fictional-layout-token');await page.locator('#new-password:enabled').waitFor();
 for(const width of [1280,390,320])await audit('public-reset',width);
 check(!errors.length&&!unknown.length&&!writes.length,'UNEXPECTED_IO');
 if(!baseline)check(!issues.length,'FORM_OVERFLOW '+JSON.stringify(issues.slice(0,12)));
 return {passed:!issues.length,baseline,mode,cloud,results,issues,screenshots,errors,writes,unknown,requests,scope:(cloud?'Cloudflare':'Local')+' product assets with fictional GET-only data; iOS theme sizing is separately simulated, not a physical iPhone test.'};
}catch(error){throw Error('FORM_LAYOUT_STEP_'+step+' '+error.message);}
}
