async(page,owner)=>{
 const {id,input,base,output,mode}=owner;
 const check=(value,code)=>{if(!value)throw Error(code);};const button=name=>page.getByRole('button',{name,exact:true});
 const errors=[],writes=[],unknown=[],results=[],screenshots=[];let state='history',requests=0;
 const isOld=()=>['stale','combined','revision','stale-notrun','recompute'].includes(state);
 const validation=()=>({status:['invalid','combined','unknown','recompute','invalid-empty','allocation'].includes(state)?'INVALID':['notrun','stale-notrun'].includes(state)?'NOT_RUN':['history','deleted','corrupt'].includes(state)?'HISTORY_UNVERIFIED':'VERIFIED',violations:['invalid','combined'].includes(state)?[`CONTRACT:${id.staff[1]}:2026-10-01`]:state==='allocation'?[`WAITING:${id.staff[0]}:2026-10-01`]:state==='unknown'?['FUTURE_CHECK:unrecognized']:state==='recompute'?['WORKED_MINUTES','ASSIGNMENT_KEYS','FUTURE_CHECK:unrecognized']:[],missingHistory:['history','combined','deleted'].includes(state)?[`${id.staff[1]}:2026-09-30`,`${id.staff[0]}:2026-09-29`,`${id.staff[1]}:2026-09-29`]:state==='corrupt'?['not-a-staff-date']:[],generalShortage:state==='shortage'?60:0,roleSameShortage:0,preferences:[],roleRequirements:[],intervals:[]});
 const job=()=>({id:id.job,month:'2026-10',state:'SUCCEEDED',attempt:1,snapshot_id:id.snapshot,input_revision:1,solver_status:'FEASIBLE',validation_status:validation().status,failure_code:null,stale:isOld(),created_at:1});
 const config={slotMinutes:input.slotMinutes,priority:input.priority,capacityScale:input.capacityScale,patterns:input.patterns,tasks:input.tasks.map(t=>({...t,capacities:[{level:1,capacity:60}]})),roles:input.roles,transitions:input.transitions,rolePolicies:[]};
 const assignments=input.staff.flatMap(s=>Array.from({length:31},(_,i)=>({staffId:s.id,date:`2026-10-${String(i+1).padStart(2,'0')}`,shift:null,blocks:[],roleIntervals:[]})));
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const r=route.request(),u=new URL(r.url()),p=u.pathname;requests++;
  if(u.origin!==base||requests>(mode==='cloud'?150:400)){unknown.push(p);await route.abort();return;}
  if(r.method()!=='GET'){writes.push(p);await route.abort();return;}
  if(!p.startsWith('/api/')){await route.continue();return;}
  let body;
  if(p==='/api/access')body={userId:'synthetic-admin',mustChange:false};
  else if(p==='/api/context')body={userId:'synthetic-admin',companies:[{id:id.company,name:'公開案内確認用の架空企業',revision:state==='revision'?2:1,role:'company_admin',teams:[{id:id.team,name:'架空チーム',role:null,staff_id:null}]}]};
  else if(p.endsWith('/staff'))body={staff:id.staff.filter((_,i)=>state!=='deleted'||i===0).map((person,i)=>({id:person,name:'架空スタッフ'+(i+1),staff_number:'000'+(i+1),user_id:'synthetic-'+i,role:'staff',status:'active'}))};
  else if(p.includes('/readiness/'))body={companyId:id.company,teamId:id.team,month:p.split('/').pop(),inputRevision:state==='revision'?2:1,draftRevision:0,canCompute:true,items:['calendar','company_policy','team_config','staff','contracts','planning','consistency','history','preferences'].map(key=>({id:key,status:'complete',required:!['history','preferences'].includes(key),message:'確認済み',section:'schedule'}))};
  else if(p.endsWith('/jobs'))body={jobs:[job()]};
  else if(p.endsWith('/jobs/'+id.job))body=job();
  else if(p.endsWith('/result'))body={stale:isOld()&&state!=='revision',publication:'BLOCKED_A1',result:{jobId:id.job,month:'2026-10',solverStatus:'FEASIBLE',assignments,validation:validation(),stages:[],publication:'BLOCKED_A1'}};
  else if(p.endsWith('/drafts'))body={draftRevision:0,draft:null};
  else if(p.endsWith('/publications/history'))body={versions:[],nextCursor:null};
  else if(p.endsWith('/publications/notices'))body={notices:[],nextCursor:null};
  else if(p.endsWith('/publications'))body={publicationRevision:0,publication:null};
  else if(p.includes('/config/'))body={version:{id:'synthetic-config',effectiveFrom:'2026-10',revision:1,payload:config}};
  else if(p.includes('/planning/'))body={version:{id:'synthetic-plan',effectiveFrom:'2026-10',revision:1,payload:{demand:[],events:[],roleRequirements:[]}}};
  else if(p.includes('/calendar-settings/')||p.includes('/company-policy/'))body={version:null};
  else if(p.endsWith('/changes'))body={snapshotId:id.snapshot,month:'2026-10',inputRevision:1,currentRevision:state==='revision'?2:1,sourceDraftRevision:0,currentDraftRevision:0,currentInputStatus:'COMPILED',currentInputError:null,changes:[],totals:{input:0,publication:0},total:0,offset:0,nextOffset:null};
  else if(p.includes('/snapshots/'))body={input,stale:false,publication:'NOT_EVALUATED',draftSource:null};
  else if(p.includes('/history/'))body={month:p.split('/').pop(),inputRevision:1,window:{first:'2026-10-01',last:'2026-10-31',previousFrom:'2026-08-31',nextThrough:'2026-12-01'},records:[],required:id.staff.flatMap(staffId=>['2026-09-29','2026-09-30'].map(date=>({staffId,date}))),missing:id.staff.flatMap(staffId=>['2026-09-29','2026-09-30'].map(date=>({staffId,date})))};
  else if(p.includes('/explanations/')){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'INTERNAL_ERROR'})});return;}
  else{unknown.push(p);await route.abort();return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 const panel=()=>page.getByLabel('公開前の確認と対応',{exact:true});
 const load=async next=>{state=next;await page.goto(base+'/app?month=2026-10');await page.locator('.candidate-monthly .month-table').waitFor();if(!['shortage','ready'].includes(next)){await panel().waitFor();check(!await panel().locator('details').evaluate(el=>el.open),'GUIDANCE_DEFAULT_OPEN');await panel().locator('summary').click();}};
 await load('history');
 check(await panel().getByLabel('必須条件違反への対応',{exact:true}).count()===0,'HISTORY_HAS_FALSE_VIOLATIONS');check(await panel().getByLabel('古い案への対応',{exact:true}).count()===0,'HISTORY_HAS_FALSE_STALE');check(await button('シフトを公開').isDisabled(),'HISTORY_PUBLISH_ENABLED');
 await panel().getByText('未確認の日付：2026-09-29、2026-09-30',{exact:true}).waitFor();
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});await panel().scrollIntoViewIfNeeded();
  const rect=await panel().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,document:document.documentElement.scrollWidth};});check(rect.left>=0&&rect.right<=width&&rect.document<=width,'PANEL_OVERFLOW_'+width);
  const path=output+'/history-'+width+'.png';await page.screenshot({path,fullPage:false});screenshots.push(path);results.push({width,...rect});
 }
 const openHistory=()=>panel().getByRole('button',{name:'架空スタッフ2（0002）の勤務履歴を修正',exact:true});
 if(mode==='local'){
  await page.locator('.draft-editor > details > summary').click();await page.getByRole('combobox',{name:'勤務パターン',exact:true}).selectOption(input.patterns[0].id);await openHistory().click();await page.getByRole('alertdialog').waitFor();await button('編集を続ける').click();check(await panel().count()===1,'CANCEL_LOST_SCHEDULE');await openHistory().click();await button('変更を破棄して進む').click();
 }else{await openHistory().focus();await page.keyboard.press('Enter');}
 await page.getByRole('heading',{name:'月境界の勤務履歴',exact:true}).waitFor();await page.locator('[data-history-date="2026-09-29"]').waitFor();
 check(await page.getByRole('combobox',{name:'履歴を確認するスタッフ',exact:true}).inputValue()===id.staff[1],'WRONG_PERSON');
 check(await page.locator('[data-history-date="2026-09-29"]').evaluate(el=>el===document.activeElement),'DATE_NOT_FOCUSED');
 check(await page.getByRole('group',{name:'2026-09-29の勤務履歴',exact:true}).getByRole('textbox',{name:'勤務時間(分)',exact:true}).count()===0,'NUMERIC_FIELD_ROLE_CHANGED');
 const historyPath=output+'/history-target-320.png';await page.screenshot({path:historyPath,fullPage:false});screenshots.push(historyPath);
 if(mode==='local'){
  await page.getByRole('group',{name:'2026-09-29の勤務履歴',exact:true}).getByRole('spinbutton',{name:'勤務時間(分)',exact:true}).fill('0');await button('シフト・計算結果').click();await page.getByRole('alertdialog').waitFor();await button('編集を続ける').click();check(await page.getByRole('heading',{name:'月境界の勤務履歴',exact:true}).count()===1,'HISTORY_UNSAVED_LOST');await button('シフト・計算結果').click();await button('変更を破棄して進む').click();
 }
 await load('invalid');await panel().getByText('架空スタッフ2（0002） ／ 2026-10-01',{exact:true}).waitFor();check(await panel().getByLabel('履歴不足への対応',{exact:true}).count()===0,'INVALID_HAS_FALSE_HISTORY');check(await button('シフトを公開').isDisabled(),'INVALID_PUBLISH_ENABLED');
 if(mode==='local'){
  await load('allocation');check(!await page.locator('.draft-editor > details').evaluate(el=>el.open),'EDITOR_DEFAULT_OPEN');await panel().getByRole('button',{name:'業務配置・編集案を確認',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.draft-editor > details')?.open);check(await page.locator('.candidate-monthly .month-table').isVisible(),'EDITOR_GUIDANCE_MONTHLY');
  await load('combined');for(const reason of ['履歴不足への対応','必須条件違反への対応','古い案への対応'])check(await panel().getByLabel(reason,{exact:true}).count()===1,'COMBINED_REASON_MISSING');
  await load('notrun');check(await panel().getByLabel('未検証への対応',{exact:true}).count()===1,'UNVERIFIED_REASON_MISSING');check(await panel().getByLabel('履歴不足への対応',{exact:true}).count()===0,'UNVERIFIED_FALSE_HISTORY');
  await load('unknown');await panel().getByText('確認コード：FUTURE_CHECK:unrecognized',{exact:true}).waitFor();
  for(const next of ['stale-notrun','recompute','invalid-empty']){
   await load(next);check(await panel().getByRole('button',{name:'計算ボタンへ',exact:true}).count()===0,'COMPUTE_GUIDANCE_REMAINS_'+next);check(await button('シフトを公開').isDisabled(),'BLOCKED_PUBLISH_ENABLED_'+next);
   if(next==='stale-notrun')for(const reason of ['古い案への対応','未検証への対応'])check(await panel().getByLabel(reason,{exact:true}).count()===1,'COMBINED_UNVERIFIED_REASON_MISSING');
   if(next==='recompute')for(const code of ['WORKED_MINUTES','ASSIGNMENT_KEYS','FUTURE_CHECK:unrecognized'])await panel().getByText('確認コード：'+code,{exact:true}).waitFor();
   if(next==='stale-notrun'){await panel().scrollIntoViewIfNeeded();const path=output+'/stale-notrun-320.png';await page.screenshot({path,fullPage:false});screenshots.push(path);}
  }
  await load('corrupt');await button('勤務履歴を確認').waitFor();check(await panel().getByRole('button',{name:/の勤務履歴を修正/}).count()===0,'CORRUPT_HISTORY_LINKED');
  await load('deleted');await panel().getByRole('button',{name:`当時のスタッフ（ID: ${id.staff[1]}）の勤務履歴を修正`,exact:true}).click();await page.getByRole('heading',{name:'月境界の勤務履歴',exact:true}).waitFor();check(await page.getByRole('combobox',{name:'履歴を確認するスタッフ',exact:true}).inputValue()===id.staff[1],'DELETED_PERSON_LOST');
  await page.getByRole('textbox',{name:'対象月',exact:true}).fill('2026-11');await page.getByRole('textbox',{name:'対象月',exact:true}).press('Tab');await page.waitForTimeout(200);check(await page.getByText(/公開前の履歴不足から移動しました/).count()===0,'TARGET_SCOPE_LEAK');
  await load('revision');await panel().getByLabel('古い案への対応',{exact:true}).waitFor();check(await button('シフトを公開').isDisabled(),'REVISION_MISMATCH_PUBLISHED');
 }
 await load('stale');check(await panel().getByLabel('履歴不足への対応',{exact:true}).count()===0,'STALE_HAS_FALSE_HISTORY');check(await panel().getByRole('button',{name:'計算ボタンへ',exact:true}).count()===0,'COMPUTE_GUIDANCE_REMAINS');
 if(mode==='local'){
  await load('shortage');check(!await button('シフトを公開').isDisabled(),'SHORTAGE_BLOCKS_OPEN');await button('シフトを公開').click();check(await button('再検証して公開').isDisabled(),'SHORTAGE_ACK_BYPASSED');await page.getByRole('checkbox',{name:/不足を確認し、この案を公開する/}).check();check(!await button('再検証して公開').isDisabled(),'SHORTAGE_ACK_NOT_ALLOWED');
  await load('ready');check(!await button('シフトを公開').isDisabled(),'VERIFIED_DISABLED');check(await panel().count()===0,'VERIFIED_HAS_BLOCKERS');
 }
 check(errors.length===0,'PAGE_ERRORS_'+errors.join(','));check(writes.length===0,'BUSINESS_WRITE_ATTEMPT');check(unknown.length===0,'UNKNOWN_ROUTE_'+unknown.join(','));
 return {passed:true,mode,results,screenshots,checks:mode==='local'?['actual reasons only','all reasons together','collapsed guidance and no compute navigation','history staff and dates','history target selection and focus','unsaved edit guard in both directions','unknown diagnostics','missing history details fallback','archived staff history','scope change clears target','company revision mismatch','shortage acknowledgement preserved','verified can publish']:['actual history/invalid/stale only','history staff and dates','keyboard target navigation','PC and mobile layout'],errors,writes,unknown,requests};
}
