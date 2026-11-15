async(page,owner,stage)=>{
 const results=[],calls=[],assert=(ok,c)=>{if(!ok)throw Error(c);},b=name=>page.getByRole('button',{name,exact:true}),base=`/api/companies/${owner.companyId}/inputs/teams/${owner.teamId}`,route=base+'/self-month/'+owner.month;
 await page.setViewportSize({width:390,height:844});await b('勤務不可・希望').click();await page.getByRole('heading',{name:'自分の勤務不可・希望',exact:true}).waitFor();
 async function get(){return page.evaluate(async route=>await(await fetch(route)).json(),route);}
 async function post(body,path=route){return page.evaluate(async({path,body})=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};},{path,body});}
 if(stage==='submission-closed'){
  const state=await get();assert(!state.accepting,'WINDOW_STILL_ACCEPTING');await b('編集を破棄して最新を読み直す').click();await page.getByText('受付終了。変更には管理者による受付再開が必要です。',{exact:true}).waitFor();assert(!await b('すべての勤務不可・希望を保存').isEnabled(),'CLOSED_UI_EDITABLE');
  const rejected=await post({operationId:crypto.randomUUID(),expectedRevision:state.revision,payload:{unavailable:[],preferences:[]}});assert(rejected.status===409&&rejected.body.error==='SUBMISSION_CLOSED','CLOSED_SERVER_ACCEPTED_NEW_SAVE');
  const replayed=await post(owner.replay);assert(replayed.status===200&&replayed.body.replayed===true,'CLOSED_SAME_ID_NOT_REPLAYED');
  const final=await get();assert(final.revision===state.revision&&final.version.id===state.version.id,'CLOSED_SAVE_CHANGED_INPUT');results.push({name:'window closed: both UI inputs disabled, new save409, same acknowledged ID replay200 and input unchanged',passed:true});
  return {stage,companyId:owner.companyId,results,rejectedStatus:rejected.status,replayedStatus:replayed.status,revision:final.revision,version:final.version.id,cloudflareRequests:0};
 }
 const initial=await get();assert(initial.deadline.deadlineDate==='2026-09-30'&&initial.accepting,'OPEN_SUBMISSION_CONTEXT');
 const denied=await post({operationId:crypto.randomUUID(),expectedRevision:0,closesAt:null},base+'/submission-window/'+owner.month);assert(denied.status===403,'STAFF_CAN_CHANGE_WINDOW');results.push({name:'staff cannot alter manager window; deadline uses previous month-end',passed:true});
 await page.getByText('受付中',{exact:true}).waitFor();let row;
 if(stage==='submission-update'){
  assert(initial.revision===10&&initial.version.payload.preferences.length===4,'UPDATE_SOURCE_NOT_SAVED');
  row=page.locator('.setup-row').filter({has:page.getByRole('heading',{name:'希望 2',exact:true})});await row.getByLabel('日付',{exact:true}).fill('2026-10-12');
 }else{
 await b('勤務不可を追加').click();row=page.locator('.setup-row').filter({has:page.getByRole('heading',{name:'勤務不可 1',exact:true})});
 await row.getByLabel('日付',{exact:true}).fill('2026-10-07');await row.getByLabel('開始（HHMM）',{exact:true}).fill('1007');await row.getByLabel('終了（HHMM、2400可）',{exact:true}).fill('1017');
 for(const [i,kind,date] of [[1,'work','2026-10-08'],[2,'off','2026-10-09'],[3,'pattern','2026-10-08'],[4,'window','2026-10-08']]){
  await b('希望を追加').click();row=page.locator('.setup-row').filter({has:page.getByRole('heading',{name:'希望 '+i,exact:true})});await row.getByLabel('日付',{exact:true}).fill(date);await row.getByRole('combobox',{name:'希望の種類',exact:true}).selectOption(kind);
  if(kind==='pattern')await row.getByRole('combobox',{name:'勤務パターン',exact:true}).selectOption('架空日勤');
  if(kind==='window'){await row.getByLabel('希望時間帯の開始（30分単位）',{exact:true}).fill('1000');await row.getByLabel('希望時間帯の終了（30分単位）',{exact:true}).fill('1700');}
 }
 }
 const pattern='**'+route;let lost=false;
 const listener=r=>{if(r.method()==='POST'&&new URL(r.url()).pathname===route)calls.push(r.postDataJSON());};page.on('request',listener);
 await page.route(pattern,async interception=>{if(interception.request().method()!=='POST'||lost)return interception.continue();lost=true;const r=await interception.fetch();assert(r.status()===200,'PRE_LOSS_SERVER_FAILED');await interception.abort('failed');});
 await b('すべての勤務不可・希望を保存').click();await b('同じ操作を再確認').waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='同じ操作を再確認'&&!b.matches(':disabled')));
 assert(lost,'RESPONSE_LOSS_NOT_INJECTED');assert(!await b('勤務不可を追加').isEnabled(),'UNCERTAIN_INPUT_EDITABLE');await page.unroute(pattern);
 const pending=page.waitForResponse(r=>new URL(r.url()).pathname===route&&r.request().method()==='POST');await b('同じ操作を再確認').click();const r=await pending,receipt=await r.json();assert(r.status()===200&&receipt.replayed===true,'SUBMISSION_NOT_RECONCILED');
 await page.getByText('設定を保存しました。再計算で最新条件に反映されます。',{exact:true}).waitFor();page.off('request',listener);assert(calls.length===2&&calls[0].operationId===calls[1].operationId,'RECONCILIATION_CHANGED_ID');
 const saved=await get();assert(saved.revision===initial.revision+1,'REPLAY_INCREMENTED_INPUT_TWICE');assert(saved.version.payload.unavailable[0].start===607&&saved.version.payload.unavailable[0].end===617,'UNAVAILABLE_MINUTES_ROUNDED');assert(saved.version.payload.preferences.length===4,'PREFERENCE_KINDS_LOST');
 results.push({name:'real submitted response intentionally lost; same-ID UI reconciliation preserves exact minute unavailable and four preference kinds, one input revision',passed:true});
 return {stage,companyId:owner.companyId,results,receipt,initialRevision:initial.revision,saved,calls:calls.map(c=>({operationId:c.operationId,expectedRevision:c.expectedRevision})),lastCommand:calls[0],responseLossInjectedAfterReal200:true,cloudflareRequests:0};
}
