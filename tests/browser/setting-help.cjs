async(page,owner)=>{
 const {id,input,base,output,mode}=owner,check=(v,c)=>{if(!v)throw Error(c);};
 const button=n=>page.getByRole('button',{name:n,exact:true});const help=n=>button(n+'の説明');
 const dialog=n=>page.getByRole('dialog',{name:n,exact:true});
 const errors=[],writes=[],unknown=[],results=[],screenshots=[];let requests=0,step='init';try{
 const rule={dailyMax:480,weeklyMax:2400,monthlyMin:60,monthlyMax:12000,minDays:1,minOff:4,maxConsecutive:6};
 const policy={rule,contract:{weekdays:[0,1,2,3,4,5,6],start:480,end:1200},skillLevels:[{level:1,name:'標準'},{level:2,name:'熟練'}],breakRule:{basis:'elapsed',threshold:360,requiredMinutes:60,afterStart:120,beforeEnd:60}};
 const config={slotMinutes:input.slotMinutes,priority:input.priority,capacityScale:input.capacityScale,patterns:input.patterns,tasks:input.tasks.map(t=>({...t,capacities:[{level:1,capacity:60},{level:2,capacity:90}]})),roles:input.roles,transitions:input.transitions,rolePolicies:[]};
 const employment='77777777-7777-4777-8777-777777777777';
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url()),p=u.pathname;requests++;
  if(u.origin!==base||requests>150){unknown.push(p);await route.abort();return;}
  if(r.method()!=='GET'){writes.push(p);await route.abort();return;}
  if(!p.startsWith('/api/')){await route.continue();return;}
  let body;
  if(p==='/api/access')body={userId:'synthetic-admin',mustChange:false};
  else if(p==='/api/context')body={userId:'synthetic-admin',companies:[{id:id.company,name:'設定説明確認用の架空企業',revision:1,role:'company_admin',teams:[{id:id.team,name:'架空チーム',role:null,staff_id:null}]}]};
  else if(p.endsWith('/staff'))body={staff:id.staff.map((person,i)=>({id:person,name:'架空スタッフ'+(i+1),staff_number:'000'+(i+1),user_id:'synthetic-'+i,role:'staff',status:'active'}))};
  else if(p.includes('/readiness/'))body={companyId:id.company,teamId:id.team,month:'2026-10',inputRevision:1,draftRevision:0,canCompute:true,items:['calendar','company_policy','team_config','staff','contracts','planning','consistency','history','preferences'].map(key=>({id:key,status:'complete',required:!['history','preferences'].includes(key),message:'確認済み',section:'schedule'}))};
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
  else if(p.includes('/history/'))body={month:'2026-10',inputRevision:1,window:{first:'2026-10-01',last:'2026-10-31',previousFrom:'2026-08-31',nextThrough:'2026-12-01'},records:[],required:[{staffId:id.staff[0],date:'2026-09-30'}],missing:[{staffId:id.staff[0],date:'2026-09-30'}]};
  else{unknown.push(p);await route.abort();return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(base+'/app?month=2026-10');await page.getByRole('button',{name:'シフトを計算',exact:true}).waitFor();await button('企業共通ルール').click();await button('すべての企業共通設定を保存').waitFor();
 const title='日最大勤務（分）',field=page.getByRole('spinbutton',{name:title,exact:true}),initial=await field.inputValue();
 if(mode==='touch'){
  await help(title).scrollIntoViewIfNeeded();const a=await help(title).boundingBox();await page.touchscreen.tap(a.x+a.width/2,a.y+a.height/2);await dialog(title).waitFor();check((await dialog(title).innerText()).includes('480分なら8時間'),'TOUCH_TEXT');const b=await help(title).boundingBox();await page.touchscreen.tap(b.x+b.width/2,b.y+b.height/2);await dialog(title).waitFor({state:'hidden'});results.push({touchOpenClose:true});
 }else{
  step='hover';await help(title).hover();await dialog(title).waitFor();check((await dialog(title).innerText()).includes('480分なら8時間'),'PLAIN_EXAMPLE_MISSING');await dialog(title).hover();await page.waitForTimeout(220);check(await dialog(title).isVisible(),'POINTER_TRANSFER_CLOSED');step='hover-leave';await page.mouse.move(1,1);await dialog(title).waitFor({state:'hidden'});
  step='click-toggle';await help(title).click();await dialog(title).waitFor();await help(title).click();await dialog(title).waitFor({state:'hidden'});
  step='keyboard';await help(title).focus();await page.keyboard.press('Enter');await dialog(title).waitFor();await page.keyboard.press('Escape');await dialog(title).waitFor({state:'hidden'});check(await help(title).evaluate(el=>el===document.activeElement),'ESCAPE_FOCUS_LOST');
  step='close-button';await page.keyboard.press('Space');await dialog(title).waitFor();await button('説明を閉じる').click();await dialog(title).waitFor({state:'hidden'});check(await help(title).evaluate(el=>el===document.activeElement),'CLOSE_FOCUS_LOST');
  step='outside';await help(title).click();await dialog(title).waitFor();await field.click();await dialog(title).waitFor({state:'hidden'});
 }
 check(await field.inputValue()===initial,'HELP_CHANGED_VALUE');
 // The visual label still focuses the input, with the original accessible name.
 await page.locator('.field-heading > label').filter({hasText:new RegExp('^日最大勤務（分）$')}).click();check(await field.evaluate(el=>el===document.activeElement),'LABEL_ASSOCIATION_BROKEN');
 for(const width of mode==='touch'?[390,320]:[1280,390,320]){
  await page.setViewportSize({width,height:800});await help('毎月の希望締切日').scrollIntoViewIfNeeded();await help('毎月の希望締切日').click();await dialog('毎月の希望締切日').waitFor();
  const rect=await dialog('毎月の希望締切日').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,document:document.documentElement.scrollWidth};});check(rect.left>=8&&rect.right<=width-8&&rect.top>=8&&rect.bottom<=800-8&&rect.document<=width,'POPUP_OVERFLOW_'+width);
  check((await dialog('毎月の希望締切日').innerText()).includes('9月20日'),'DEADLINE_EXAMPLE');const file=output+'/policy-'+width+'.png';await page.screenshot({path:file,fullPage:false});screenshots.push(file);await button('説明を閉じる').click();results.push({width,...rect});
 }
 if(mode!=='touch'){
  await help(title).evaluate(el=>el.closest('fieldset').disabled=true);await help(title).click();await dialog(title).waitFor();await button('説明を閉じる').click();await help(title).evaluate(el=>el.closest('fieldset').disabled=false);results.push({disabledFieldsetHelp:true});
 }
 await button('チーム設定').click();await button('すべてのチーム設定を保存').waitFor();check(await page.getByRole('alertdialog').count()===0,'HELP_MARKED_DIRTY');
 await help('最低習熟度').first().click();await dialog('最低習熟度').waitFor();check((await dialog('最低習熟度').innerText()).includes('自動配置対象'),'MIN_LEVEL_HELP');await button('説明を閉じる').click();
 await help('標準 の能力係数').first().click();await dialog('標準 の能力係数').waitFor();check((await dialog('標準 の能力係数').innerText()).includes('0.5'),'CAPACITY_HELP');await button('説明を閉じる').click();
 await button('需要管理').click();await button('期間を指定して必要人数の一括入力').click();await help('一括入力 直接必要人数').click();await dialog('一括入力 直接必要人数').waitFor();check((await dialog('一括入力 直接必要人数').innerText()).includes('0は「必要なし」'),'ZERO_AND_UNSET');await button('説明を閉じる').click();
 await button('スタッフ管理').click();await button('勤務契約・習熟度・対応可能な担当をすべて保存').waitFor();await help('適用する雇用区分').click();await dialog('適用する雇用区分').waitFor();await button('説明を閉じる').click();
 const own=page.getByRole('checkbox',{name:'個人の追加勤務ルールを設定する',exact:true});check(!await own.isChecked(),'OWN_RULE_INITIAL');await help('個人の追加勤務ルールを設定する').click();await dialog('個人の追加勤務ルールを設定する').waitFor();await button('説明を閉じる').click();check(!await own.isChecked(),'HELP_TOGGLED_CHECKBOX');
 await button('勤務履歴').click();await help('勤務時間(分)').click();await dialog('勤務時間(分)').waitFor();check((await dialog('勤務時間(分)').innerText()).includes('休日は0分'),'HISTORY_HELP');await button('説明を閉じる').click();
 check(await page.getByLabel('一覧にない前月・翌月の勤務日を追加',{exact:true}).count()===1,'HISTORY_LABEL_NOT_RENAMED');check(await page.getByText('追加する確定履歴の日付',{exact:true}).count()===0,'OLD_HISTORY_LABEL');
 await help('一覧にない前月・翌月の勤務日を追加').click();await dialog('一覧にない前月・翌月の勤務日を追加').waitFor();const file=output+'/history-label.png';await page.screenshot({path:file,fullPage:false});screenshots.push(file);await button('説明を閉じる').click();
 check(errors.length===0,'PAGE_ERRORS_'+errors.join(','));check(writes.length===0,'BUSINESS_WRITE_ATTEMPT');check(unknown.length===0,'UNKNOWN_ROUTE_'+unknown.join(','));
 return {passed:true,mode,results,screenshots,checks:['plain language examples','hover/click/touch or keyboard open/close','popup position and mobile overflow','input labels retained','no changes or form submission from help','company/team/demand/contract/history help','renamed history date field'],errors,writes,unknown,requests};
}catch(error){throw Error('SETTING_HELP_STEP_'+step+' '+error.message);}
}
