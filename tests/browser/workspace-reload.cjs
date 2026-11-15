async(page,owner)=>{
 const {id,input,base,output,mode}=owner,check=(v,c)=>{if(!v)throw Error(c);};
 const button=n=>page.getByRole('button',{name:n,exact:true});const help=n=>button(n+'の説明');
 const dialog=n=>page.getByRole('dialog',{name:n,exact:true});
 const errors=[],writes=[],unknown=[],results=[],screenshots=[];let requests=0,step='init',access='company_admin',noTeams=false;const protectedReads=[];try{
 const rule={dailyMax:480,weeklyMax:2400,monthlyMin:60,monthlyMax:12000,minDays:1,minOff:4,maxConsecutive:6};
 const policy={rule,contract:{weekdays:[0,1,2,3,4,5,6],start:480,end:1200},skillLevels:[{level:1,name:'標準'},{level:2,name:'熟練'}],breakRule:{basis:'elapsed',threshold:360,requiredMinutes:60,afterStart:120,beforeEnd:60}};
 const config={slotMinutes:input.slotMinutes,priority:input.priority,capacityScale:input.capacityScale,patterns:input.patterns,tasks:input.tasks.map(t=>({...t,capacities:[{level:1,capacity:60},{level:2,capacity:90}]})),roles:input.roles,transitions:input.transitions,rolePolicies:[]};
 const employment='77777777-7777-4777-8777-777777777777';
 page.removeAllListeners('dialog');page.on('dialog',d=>d.accept());await page.unrouteAll({behavior:'wait'});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url()),p=u.pathname;requests++;
  if(u.origin!==base||requests>600){unknown.push(p);await route.abort();return;}
  if(r.method()!=='GET'){writes.push(p);await route.abort();return;}
  if(!p.startsWith('/api/')){await route.continue();return;}
  let body;if(access==='staff'&&/\/(config|planning|company-policy|calendar-settings)\//.test(p))protectedReads.push(p);if(access==='team_admin'&&/\/(company-policy|calendar-settings)\//.test(p))protectedReads.push(p);
  if(p==='/api/access')body={userId:'synthetic-admin',mustChange:false};
  else if(p==='/api/context')body={userId:'synthetic-admin',companies:[{id:id.company,name:'画面復元確認用の架空企業',revision:1,role:access,teams:noTeams?[]:[{id:id.team,name:'架空チーム',role:access==='company_admin'?null:access,staff_id:id.staff[0]},{id:id.otherTeam,name:'別の架空チーム',role:'staff',staff_id:id.staff[0]}]},{id:id.otherCompany,name:'別の架空企業',revision:1,role:'company_admin',teams:[{id:id.otherTeam,name:'企業切替後のチーム',role:null,staff_id:id.staff[0]}]}]};
  else if(p.endsWith('/staff'))body={staff:id.staff.map((person,i)=>({id:person,name:'架空スタッフ'+(i+1),staff_number:'000'+(i+1),user_id:'synthetic-'+i,role:'staff',status:'active'}))};
  else if(p.includes('/readiness/'))body={companyId:p.split('/')[3],teamId:p.split('/')[6],month:p.split('/').pop(),inputRevision:1,draftRevision:0,canCompute:true,items:['calendar','company_policy','team_config','staff','contracts','planning','consistency','history','preferences'].map(key=>({id:key,status:'complete',required:!['history','preferences'].includes(key),message:'確認済み',section:'schedule'}))};
  else if(p.endsWith('/jobs'))body={jobs:[]};
  else if(p.endsWith('/drafts'))body={draftRevision:0,draft:null};
  else if(p.endsWith('/publications/history'))body={versions:[],nextCursor:null};
  else if(p.endsWith('/publications/notices'))body={notices:[],nextCursor:null};
  else if(p.endsWith('/publications'))body={publicationRevision:0,publication:null};
  else if(p.includes('/config/'))body={version:{id:'synthetic-config',effectiveFrom:'2026-10',revision:1,payload:config}};
  else if(p.includes('/planning/'))body={version:{id:'synthetic-plan',effectiveFrom:'2026-10',revision:1,payload:{demand:[{date:'2026-10-01',start:540,end:600,taskId:input.tasks[0].id,direct:60,calculated:null}],events:[],roleRequirements:[]}}};
  else if(p.includes('/calendar-settings/'))body={version:{settings:{weekStart:0,deadlineDay:20,halfDayDivider:720,roleRounding:'ceil'}}};
  else if(p.includes('/company-policy/'))body={version:{id:'synthetic-policy',effectiveFrom:'2026-10',revision:1,payload:policy}};
  else if(p.includes('/contract-options/'))body={revision:1,policy,employment:[{id:employment,version:employment,effectiveFrom:'2026-10',revision:1,payload:{name:'架空雇用区分',rule,contract:policy.contract}}],roleRounding:'ceil'};
  else if(p.includes('/contract/'))body={version:{id:'synthetic-contract',effectiveFrom:'2026-10',revision:1,payload:{employmentTypeId:employment,contract:policy.contract,rule:null,skills:input.staff[0].skills.map(s=>({taskId:s.taskId,level:s.level})),roleIds:[]}}};
  else if(p.includes('/self-month/'))body={month:'2026-10',revision:1,staffId:id.staff[0],calendarId:id.company,serverTime:1,deadline:{month:'2026-10',configuredDay:20,deadlineDate:'2026-09-20',timeZone:'Asia/Tokyo',closesAt:1},window:null,accepting:true,version:{id:id.staff[0],revision:1,payload:{unavailable:[{date:'2026-10-01',start:607,end:617}],preferences:[{date:'2026-10-01',kind:'window',start:600,end:1020}]}},patterns:input.patterns};
  else if(p.includes('/submission-window/'))body={month:'2026-10',serverTime:1,window:null,deadline:{month:'2026-10',configuredDay:20,deadlineDate:'2026-09-20',timeZone:'Asia/Tokyo',closesAt:1}};
  else if(p.includes('/history/'))body={month:'2026-10',inputRevision:1,window:{first:'2026-10-01',last:'2026-10-31',previousFrom:'2026-08-31',nextThrough:'2026-12-01'},records:[],required:[{staffId:id.staff[0],date:'2026-09-30'}],missing:[{staffId:id.staff[0],date:'2026-09-30'}]};
  else if(p.endsWith('/leave/context'))body={publicationId:null,publicationRevision:0,halfDayDivider:720,staff:[],assignments:[]};
  else if(p.endsWith('/leave')||p.endsWith('/leave/notices'))body=p.endsWith('/notices')?{notices:[],nextCursor:null}:{records:[],nextCursor:null};
  else{unknown.push(p);await route.abort();return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });


 const heading=name=>page.getByRole('heading',{name,exact:true,level:1});
 const ready=async name=>{await heading(name).waitFor();await page.waitForFunction(()=>{const b=document.querySelector('.topbar button');return b&&!b.disabled&&document.querySelectorAll('[data-slot=loading][aria-busy=true]').length===0;});};
 const query=()=>new URL(page.url()).searchParams;
 const section=async(key,name)=>{await ready(name);await page.waitForFunction(k=>new URLSearchParams(location.search).get('section')===k,key);check((await page.locator('.sidebar .selected').innerText())===(access==='staff'&&key==='schedule'?'シフト・計算結果':name),'SIDEBAR_MISMATCH_'+key);};
 const reload=async(key,name)=>{await page.reload();await section(key,name);check(query().get('month')==='2026-10','MONTH_LOST');};
 await page.goto(base+'/app?month=2026-10&extra=keep#anchor');await section('schedule','シフト・計算結果');
 const sections=[['demand','需要管理'],['history','勤務履歴'],['leave','休暇・欠勤'],['submission','勤務不可・希望'],['team','チーム設定'],['staff','スタッフ管理'],['company','企業共通ルール'],['schedule','シフト・計算結果']];
 for(const[key,name]of sections){step='reload-'+key;await button(name).click();await section(key,name);await reload(key,name);results.push({screen:key,reloadPreserved:true});}
 for(const legacy of ['monthly','result','daily']){step='legacy-'+legacy;await page.goto(base+'/app?month=2026-10&section=schedule&tab='+legacy+'&extra=keep#anchor');await section('schedule','シフト・計算結果');check(!query().has('tab'),'LEGACY_TAB_REMAINS');check(await page.getByRole('tablist',{name:'案の表示'}).count()===0,'TABS_REMAIN');check(await button('計算結果').isDisabled(),'EMPTY_RESULT_ENABLED');await reload('schedule','シフト・計算結果');check(await dialog('計算結果').count()===0,'RESULT_MODAL_RESTORED');results.push({legacy,monthlyDefault:true,modalNotRestored:true});}
 check(query().get('extra')==='keep'&&new URL(page.url()).hash==='#anchor','UNRELATED_URL_LOST');
 step='unsaved';await button('チーム設定').click();await section('team','チーム設定');const slot=page.getByRole('combobox',{name:'業務配置枠',exact:true});const changedSlot=(await slot.inputValue())==='60'?'30':'60';await slot.selectOption(changedSlot);await button('需要管理').click();await page.getByRole('alertdialog').waitFor();await button('編集を続ける').click();check(query().get('section')==='team'&&await slot.inputValue()===changedSlot,'CANCEL_CHANGED_URL_OR_FORM');
 await button('需要管理').click();await page.getByRole('alertdialog').waitFor();await button('変更を破棄して進む').click();await section('demand','需要管理');await reload('demand','需要管理');results.push({unsavedCancelPreservesUrl:true,confirmedNavigationPersists:true});
 step='scope';await button('スタッフ管理').click();await section('staff','スタッフ管理');await page.getByRole('combobox',{name:'チーム',exact:true}).selectOption(id.otherTeam);await ready('スタッフ管理');await page.waitForFunction(t=>new URLSearchParams(location.search).get('team')===t,id.otherTeam);await reload('staff','スタッフ管理');check(query().get('team')===id.otherTeam,'TEAM_LOST');
 await page.getByRole('combobox',{name:'企業',exact:true}).selectOption(id.otherCompany);await ready('スタッフ管理');await page.waitForFunction(c=>new URLSearchParams(location.search).get('company')===c,id.otherCompany);await reload('staff','スタッフ管理');check(query().get('company')===id.otherCompany,'COMPANY_LOST');results.push({companyAndTeamPreserved:true});
 step='mobile';for(const width of [390,320]){await page.setViewportSize({width,height:900});await button('需要管理').click();await reload('demand','需要管理');check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'MOBILE_OVERFLOW');const file=output+'/reload-'+width+'.png';await page.screenshot({path:file,fullPage:false});screenshots.push(file);results.push({width,reloadPreserved:true});}
 step='invalid';await page.goto(base+'/app?month=2026-10&section=unknown&tab=unknown');await section('schedule','シフト・計算結果');check(!query().has('tab'),'INVALID_TAB');
 step='legacy-daily';await page.goto(base+'/app?month=2026-10&section=schedule&tab=daily');await section('schedule','シフト・計算結果');check(!query().has('tab'),'LEGACY_DAILY_NOT_MONTHLY');
 step='staff';access='staff';await page.goto(base+'/app?month=2026-10&section=staff');await section('schedule','自分のシフト');check(await button('スタッフ管理').count()===0,'STAFF_RESTORED_ADMIN_SCREEN');
 for(const[key,name]of [['leave','休暇・欠勤'],['submission','勤務不可・希望']]){await button(name).click();await reload(key,name);}results.push({staffScreensPreserved:true,staffRejectsAdminUrl:true});
 step='team-admin';access='team_admin';await page.goto(base+'/app?month=2026-10&section=company');await section('schedule','シフト・計算結果');check(await button('企業共通ルール').count()===0,'TEAM_ADMIN_RESTORED_COMPANY');results.push({teamAdminRejectsCompanyUrl:true});
 step='no-team';access='company_admin';noTeams=true;await page.goto(base+'/app?month=2026-10');await section('company','企業共通ルール');await reload('company','企業共通ルール');results.push({companyWithoutTeamsDefaultPreserved:true});
 check(!protectedReads.length,'UNAUTHORIZED_READ');check(!errors.length&&!unknown.length&&!writes.length,'UNEXPECTED_IO');return {passed:true,results,screenshots,errors,writes,unknown,protectedReads,requests,scope:'Product assets with fictional GET-only responses; no business writes or solve.'};
}catch(error){throw Error('WORKSPACE_RELOAD_STEP_'+step+' '+error.message);}
}
