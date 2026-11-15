async page => {
 await page.clock.resume().catch(()=>{});
 const origin='http://127.0.0.1:8799', output='output/playwright/schedule-ui';
 const check=(condition,code)=>{if(!condition)throw Error(code);};
 const results=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const state=async value=>{const r=await page.request.post(origin+'/__test/state',{data:value});check(r.ok(),'CONTROL_FAILED');return r.json();};
 let step='readiness';try{
 const fixture=await(await page.request.get(origin+'/__test/fixture')).json();
 const button=(name,target=page)=>target.getByRole('button',{name,exact:true});
 const load=async section=>{await page.goto(origin+'/app?month=2026-10&section='+section);await page.getByRole('heading',{name:section==='readiness'?'シフト計算の準備':'シフト・計算結果',exact:true,level:1}).waitFor();};
 const popup=()=>page.getByRole('dialog',{name:'計算時からの変更',exact:true});
 const modal=()=>page.locator('.staff-dialog-content');
 const close=async()=>{await button('勤務一覧を閉じる',modal()).click();await modal().waitFor({state:'hidden'});};
 await state({stale:true,role:'company_admin',status:'VERIFIED',cycle:0,requests:{},writes:[],noCandidate:false,noPublication:false,manual:false,missing:false,readinessFailure:false,historyFailure:false,certificateFailure:false,changesFailure:false,changesZero:false,changesUnavailable:false,releaseFailure:false,delay:0,certificateMode:'',generalShortage:19800,roleSameShortage:0});
 await load('readiness');await page.locator('.readiness-item').nth(8).waitFor();
 check(await page.locator('.readiness-item').count()===9,'READINESS_NOT_NINE');
 check(await page.locator('.readiness-panel details').count()===0,'READINESS_COLLAPSED');
 check(new URL(page.url()).searchParams.get('section')==='readiness','READINESS_URL');
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'READINESS_OVERFLOW_'+width);
  await page.screenshot({path:output+'/readiness-'+width+'.png',fullPage:true});
 }
 await page.reload();await page.locator('.readiness-item').nth(8).waitFor();
 await button('シフト・計算結果へ').click();await page.locator('.candidate-monthly .month-table').waitFor();
 await page.locator('.publication-disclosure > summary').click();
 check(await page.locator('.readiness-panel').count()===0,'READINESS_STILL_INLINE');
 check(await page.getByRole('combobox',{name:'公開済み勤務を確認するスタッフ',exact:true}).count()===0,'PERSON_SELECT_STILL_INLINE');
 check(await page.locator('.published-days').count()===0,'PERSON_DAYS_STILL_INLINE');
 check(await page.locator('.input-changes').count()===0,'CHANGES_EAGERLY_RENDERED');
 const before=(await state({})).requests;
 check(!Object.keys(before).some(path=>path.endsWith('/changes')),'CHANGES_EAGERLY_FETCHED');
 step='popup-open';await button('計算時からの変更の説明').hover();await popup().waitFor();await popup().getByText('55件の変更（50件を表示）',{exact:true}).waitFor();
 await popup().hover();await page.waitForTimeout(220);check(await popup().isVisible(),'POPUP_POINTER_TRANSFER');
 await button('次の50件を確認',popup()).click();await popup().getByText('55件の変更（55件を表示）',{exact:true}).waitFor();
 check(await popup().locator('tbody tr').count()===55,'CHANGES_PAGINATION');
 await button('説明を閉じる',popup()).click();
 const countChanges=async()=>Object.entries((await state({})).requests).filter(([path])=>path.endsWith('/changes')).reduce((sum,[,n])=>sum+n,0);
 const fetched=await countChanges();await button('計算時からの変更の説明').press('Enter');await popup().waitFor();
 check(await popup().locator('tbody tr').count()===55,'CHANGES_CACHE_LOST');check(await countChanges()===fetched,'CHANGES_CACHE_REFETCHED');
 await state({changesFailure:true});await button('差分を読み直す',popup()).click();await popup().getByRole('alert').waitFor();check(await popup().locator('tbody tr').count()===0,'CONFLICT_OLD_COMPARISON');
 await state({changesFailure:false,changesZero:true});await button('差分を読み直す',popup()).click();await popup().getByText('合計0件の変更（0件を表示）',{exact:true}).waitFor();
 await state({changesZero:false,changesUnavailable:true});await button('差分を読み直す',popup()).click();await popup().getByText(/現在の条件を計算用に組み立てられません/).waitFor();
 for(const width of [1280,390,320]){
  if(await popup().isVisible())await button('説明を閉じる',popup()).click();
  await page.setViewportSize({width,height:900});await button('計算時からの変更の説明').click();await popup().waitFor();
  await popup().evaluate(el=>el.scrollTop=0);
  const rect=await popup().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
  check(rect.left>=7&&rect.right<=rect.width-7&&rect.top>=7&&rect.bottom<=rect.height-7,'POPUP_OVERFLOW_'+width);
  await page.screenshot({path:output+'/changes-'+width+'.png',fullPage:false});
 }
 step='popup-escape';await page.keyboard.press('Escape');await popup().waitFor({state:'hidden'});
 check(await button('計算時からの変更の説明').evaluate(el=>el===document.activeElement),'POPUP_FOCUS_LOST');
 for(let i=0;i<20;i++){
  await page.mouse.move(1,1);await page.setViewportSize({width:i%2?1280:320,height:900});
  await button('計算時からの変更の説明').click();await popup().waitFor();await page.keyboard.press('Escape');await popup().waitFor({state:'hidden'});
  await page.waitForTimeout(40);check(!await popup().isVisible(),'ESCAPE_REOPENED_'+i);
 }

 check(await page.getByText('入力が変わったため、当時の案として表示しています。',{exact:true}).count()===0,'UNCLEAR_COPY_REMAINS');
 check(await button('シフトを公開').isDisabled(),'STALE_PUBLICATION_ALLOWED');
 results.push('readiness route/all checks/responsive; lazy comparison/cache/pagination/conflict/unavailable/zero/keyboard');
 await page.mouse.move(1,1);
 await page.setViewportSize({width:1280,height:900});await page.locator('.candidate-monthly .month-table').waitFor();
 step='staff-modal';for(const person of fixture.staff){
  const trigger=button(person.name,page.locator('.candidate-monthly .month-table'));await trigger.click();await modal().getByRole('heading',{name:person.name+'の勤務一覧'}).waitFor();
  check(await modal().locator('tbody tr').count()===31,'MONTH_DAYS');
  const first=modal().locator('tbody tr').first();check((await first.innerText()).includes(person===fixture.staff[0]?'09:00〜11:00':'10:00〜12:00'),'WRONG_PERSON_CANDIDATE');
  await button('公開済み勤務',modal()).click();await modal().getByText('公開版2（現在の公開版）',{exact:true}).waitFor();
  check((await first.innerText()).includes(person===fixture.staff[0]?'09:30〜11:00':'10:30〜12:00'),'WRONG_PERSON_PUBLISHED');
  await modal().getByRole('heading',{name:'公開勤務の明示固定',exact:true}).waitFor();
  if(person===fixture.staff[1])check((await modal().locator('tbody tr').last().innerText()).includes('記録なし'),'MISSING_DAY_IS_HOLIDAY');
  check((await modal().locator('tbody tr').nth(1).innerText()).includes('休日'),'HOLIDAY_MISSING');
  check((await modal().locator('tbody tr').nth(2).innerText()).includes('10:30〜11:00')||person===fixture.staff[1],'CANCELLATION_MISSING');
  await close();await page.waitForFunction(name=>document.activeElement?.closest('.candidate-monthly .month-table')&&document.activeElement?.textContent===name,person.name);check(await trigger.evaluate(el=>el===document.activeElement),'MODAL_FOCUS_NOT_RESTORED');
 }
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});await button(fixture.staff[0].name,page.locator('.candidate-monthly .month-table')).click();await modal().waitFor();
  const rect=await modal().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};});
  check(rect.left>=11&&rect.right<=width-11&&rect.top>=11&&rect.bottom<=911,'MODAL_OVERFLOW_'+width);
  await page.keyboard.press('Tab');check(await modal().evaluate(el=>el.contains(document.activeElement)),'MODAL_FOCUS_ESCAPED');
  await page.screenshot({path:output+'/staff-'+width+'.png',fullPage:false});await page.keyboard.press('Escape');await modal().waitFor({state:'hidden'});
 }
 await page.setViewportSize({width:1280,height:900});
 step='fixed-release';await button(fixture.staff[1].name,page.locator('.published-monthly')).click();await modal().getByText('公開版2（現在の公開版）',{exact:true}).waitFor();
 await modal().getByRole('checkbox',{name:'出退勤の固定を解除',exact:true}).check();await button('勤務一覧を閉じる',modal()).click();
 await page.getByRole('alertdialog').waitFor();await button('編集を続ける',page.getByRole('alertdialog')).click();check(await modal().isVisible(),'DIRTY_RELEASE_CLOSED');
 await state({releaseFailure:true});await button('選択した固定を解除',modal()).click();await button('同じ固定解除を確認',modal()).waitFor();
 await button('勤務一覧を閉じる',modal()).click();check(await modal().isVisible(),'PENDING_RELEASE_CLOSED');
 await state({releaseFailure:false});await button('同じ固定解除を確認',modal()).click();await page.getByText('選択した固定を解除しました。公開済みの勤務時刻・休憩は維持しています。',{exact:true}).waitFor();
 const writes=(await state({})).writes.filter(write=>write.path.endsWith('/fixed/release'));check(writes.length===2&&writes[0].body.operationId===writes[1].body.operationId&&writes[0].body.staffId===fixture.staff[1].id,'RELEASE_TARGET_OR_RETRY_ID');
 await close();
 const history=page.locator('details').filter({has:page.locator('summary').filter({hasText:'公開履歴'})}).first();await history.locator(':scope > summary').click();await button('公開版1を表示',history).click();
 await button(fixture.staff[0].name,page.locator('.published-monthly')).click();await modal().getByText('公開版1（過去の公開版・閲覧のみ）',{exact:true}).waitFor();check(await modal().getByRole('heading',{name:'公開勤務の明示固定',exact:true}).count()===0,'PAST_VERSION_RELEASE_ALLOWED');await close();
 results.push('two staff/candidate/publication/monthly details/modal layout/focus/fixed release guards and idempotent retry/past version');
 // Pending/RUNNING heads update through the real 3s polling effect, 24 times.
 step='polling';await state({status:'PENDING',cycle:0,delay:0});await load('schedule');await page.locator('.publication-validation').waitFor();await page.clock.install();
 for(let i=1;i<=24;i++){
  await state({status:i%2?'RUNNING':'PENDING',cycle:i});await page.clock.fastForward(3100);
  await page.waitForFunction(status=>document.querySelector('.publication-validation [role=status]')?.textContent.includes(status),i%2?'最新条件で再検証中':'最新条件での再検証待ち');
  await page.waitForFunction(()=>document.querySelectorAll('.validation-tile').length===3);
  check(await page.locator('.publication-validation').count()===1,'VALIDATION_REGION_MULTIPLIED');
  check(await page.getByRole('combobox',{name:'再検証の記録（直近100件）',exact:true}).count()===0,'HISTORY_CONTROL_REMAINS');
  check(await page.locator('.publication-validation [data-slot=loading]').count()===0,'LOADING_REMAINS');
 }
 await state({status:'VERIFIED',cycle:24});await page.clock.fastForward(3100);await page.locator('.validation-good').first().waitFor();
 await page.clock.resume();
 step='validation-errors';await state({certificateFailure:true});await load('schedule');await button('検証記録を再読込').waitFor();check(await page.locator('.publication-validation [data-slot=loading]').count()===0,'ERROR_STILL_LOADING');
 await state({certificateFailure:false});await button('検証記録を再読込').click();await page.locator('.validation-good').first().waitFor();
 await state({delay:0});for(let i=0;i<3;i++){await button('シフト計算の準備').click();await page.locator('.readiness-item').nth(8).waitFor();await button('シフト・計算結果へ').click();await page.locator('.validation-good').first().waitFor();check(await page.locator('.publication-validation').count()===1,'RETURN_MULTIPLIED_VALIDATION');}
 results.push('24 real polling cycles/current tiles/record failure and retry/round trips; history control removed');
 step='readiness-errors';await state({missing:true});await button('シフト計算の準備').click();await page.getByText('個人契約が未登録です。',{exact:true}).waitFor();await button('シフト・計算結果へ').click();check(await button('シフトを計算').isDisabled(),'MISSING_ENABLED');
 await state({missing:false,readinessFailure:true});await button('シフト計算の準備').click();await page.locator('.readiness-panel [role=alert]').waitFor();await button('シフト・計算結果へ').click();check(await button('シフトを計算').isDisabled(),'FAILED_READINESS_ENABLED');
 await state({readinessFailure:false,noCandidate:true});await load('schedule');await button(fixture.staff[0].name,page.locator('.published-monthly')).click();await modal().getByText('公開版2（現在の公開版）',{exact:true}).waitFor();await close();
 await state({noCandidate:false,noPublication:true});await load('schedule');await page.locator('.candidate-monthly .month-table').waitFor();await button(fixture.staff[0].name,page.locator('.candidate-monthly .month-table')).click();await button('公開済み勤務',modal()).click();await modal().getByText('公開済み勤務はありません。',{exact:true}).waitFor();await close();
 step='manual';await state({noPublication:false,manual:true});await load('schedule');await page.locator('.candidate-monthly .month-table').waitFor();await button(fixture.staff[0].name,page.locator('.candidate-monthly .month-table')).click();await modal().getByText('保存済みの編集案',{exact:true}).waitFor();await close();
 step='background-and-touch';await state({manual:false,stale:false,changesUnavailable:false});await load('schedule');
 await page.locator('.candidate-monthly .month-table').waitFor();
 await page.locator('.draft-editor > details > summary').click();
 const fixedInput=page.locator('.draft-editor').getByRole('checkbox',{name:'勤務パターンを固定',exact:true});await fixedInput.check();
 await button(fixture.staff[0].name,page.locator('.candidate-monthly .month-table')).click();await modal().waitFor();check(await page.getByRole('alertdialog').count()===0,'READ_OPEN_DISCARDS_BACKGROUND');await close();
 check(await fixedInput.isChecked(),'BACKGROUND_DRAFT_LOST');await button('シフト計算の準備').click();await page.getByRole('alertdialog').waitFor();await button('編集を続ける',page.getByRole('alertdialog')).click();check(await fixedInput.isChecked(),'BACKGROUND_CANCEL_LOST');
 await button('シフト計算の準備').click();await button('変更を破棄して進む',page.getByRole('alertdialog')).click();await page.locator('.readiness-item').nth(8).waitFor();
 await state({stale:true});
 const touchContext=await page.context().browser().newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
 try{const touch=await touchContext.newPage();await touch.goto(origin+'/app?month=2026-10');await touch.locator('.draft-editor').waitFor();await touch.locator('.validation-tiles').waitFor();
  await touch.locator('.publication-disclosure > summary').click();const info=button('計算時からの変更の説明',touch);await info.scrollIntoViewIfNeeded();let box=await info.boundingBox();await touch.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);
  const touchPopup=touch.getByRole('dialog',{name:'計算時からの変更',exact:true});await touchPopup.getByText('55件の変更（50件を表示）',{exact:true}).waitFor();
  box=await button('説明を閉じる',touchPopup).boundingBox();await touch.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);await touchPopup.waitFor({state:'hidden'});
  const named=button(fixture.staff[1].name,touch.locator('.published-monthly'));await named.scrollIntoViewIfNeeded();box=await named.boundingBox();await touch.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);await touch.locator('.staff-dialog-content').getByRole('heading',{name:fixture.staff[1].name+'の勤務一覧',exact:true}).waitFor();
 }finally{await touchContext.close();}
 results.push('background draft preserved and navigation guard retained; real touch popup and staff modal');
 step='staff-permissions';await state({manual:false,role:'staff'});await page.goto(origin+'/app?month=2026-10&section=readiness');await page.getByRole('heading',{name:'自分のシフト',exact:true}).waitFor();check(await button('シフト計算の準備').count()===0,'STAFF_READINESS_ACCESS');await page.locator('.published-days').waitFor();check(await page.locator('.published-days').count()===1,'SELF_SCHEDULE_REMOVED');
 check(errors.length===0,'PAGE_ERRORS:'+errors.join(','));
 results.push('missing/failed readiness blocks; publication without candidate; unpublished state; manual draft; staff permission/self display');
 return {passed:true,results,pollingCycles:24,escapeCycles:20,widths:[1280,390,320],pageErrors:errors,scope:'real built product UI with fictional loopback API; no solver or Cloudflare'};
 }catch(error){throw Error('SCHEDULE_UI_STEP '+step+' '+error.message);}
}
