async page => {
 page.setDefaultTimeout(15000);
 const origin='http://127.0.0.1:8799',output='output/playwright/schedule-details';
 const check=(condition,code)=>{if(!condition)throw Error(code);},results=[],errors=[];
 page.removeAllListeners('dialog');page.on('dialog',dialog=>dialog.accept());
 page.on('pageerror',error=>errors.push(error.message));
 const state=async patch=>{const response=await page.request.post(origin+'/__test/state',{data:patch});check(response.ok(),'STATE');return response.json();};
 const button=(name,target=page)=>target.getByRole('button',{name,exact:true});
 const modal=()=>page.locator('.schedule-detail-dialog'),tiles=()=>page.locator('.validation-tile');
 const fixture=await(await page.request.get(origin+'/__test/fixture')).json();
 const person=fixture.staff[0],other=fixture.staff[1];
 const defaults={status:'VERIFIED',cycle:0,stale:false,role:'company_admin',missing:false,readinessFailure:false,certificateFailure:false,historyFailure:false,certificateMode:'',generalShortage:19800,roleSameShortage:0,releaseFailure:false,noCandidate:false,noPublication:false,manual:false,delay:0,requests:{},writes:[]};
 const load=async(query='')=>{await page.goto(origin+'/app?month=2026-10&section=schedule'+query);await page.locator('.publication-validation').waitFor();};
 const close=async()=>{await button('詳細を閉じる',modal()).click();await modal().waitFor({state:'hidden'});};
 const monthly=async()=>{await page.locator('.candidate-monthly .month-table').waitFor();};
 const cell=(staff,date)=>button(`${staff.name} ${date} 勤務詳細`,page.locator('.candidate-monthly .month-table'));
 let step='layout';try{
 await page.setViewportSize({width:1280,height:900});await state(defaults);await load();await tiles().nth(2).getByText('0人分・分',{exact:true}).waitFor();
 check(await page.locator('main .panel').first().getByRole('heading',{name:'自分へのシフトのお知らせ',exact:true}).count()===1,'NOTICES_NOT_FIRST');
 check(await page.getByRole('tab',{name:'日別業務配置',exact:true}).count()===0,'DAILY_TAB_REMAINS');
 check(await page.getByRole('combobox',{name:'再検証の記録（直近100件）',exact:true}).count()===0,'HISTORY_SELECT_REMAINS');
 check(!Object.keys((await state({})).requests).some(path=>/publications\/[^/]+\/validations$/.test(path)),'HISTORY_REQUEST_REMAINS');
 check(!await page.locator('.draft-editor > details').evaluate(el=>el.open),'EDITOR_INITIAL_OPEN');
 check(await page.getByText(/公開版2 ／/).count()===0,'PUBLICATION_METADATA_INLINE');
 step='info';await button('公開済みシフトの情報の説明').focus();
 const info=page.getByRole('dialog',{name:'公開済みシフトの情報',exact:true});await info.waitFor();
 await info.getByText(/公開版2 ／/).waitFor();await info.getByText('当時の入力版51・公開元：計算した案',{exact:true}).waitFor();
 await info.getByText('最新の適用条件で検証済み ／ 対象入力版52・検証入力版52',{exact:true}).waitFor();
 await page.keyboard.press('Escape');await info.waitFor({state:'hidden'});check(await button('公開済みシフトの情報の説明').evaluate(el=>el===document.activeElement),'INFO_FOCUS');
 check(await tiles().count()===3,'TILES_COUNT');check(await tiles().nth(0).evaluate(el=>el.classList.contains('validation-good')),'STATUS_NOT_GREEN');
 check(await tiles().nth(1).evaluate(el=>el.classList.contains('validation-danger')),'SHORTAGE_NOT_RED');check(await tiles().nth(2).evaluate(el=>el.classList.contains('validation-good')),'ZERO_NOT_GREEN');
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});await page.locator('.publication-validation').scrollIntoViewIfNeeded();await page.screenshot({path:output+'/tiles-'+width+'.png'});
  await button('公開済みシフトの情報の説明').press('Enter');await info.waitFor();await page.screenshot({path:output+'/info-'+width+'.png'});await page.keyboard.press('Escape');await info.waitFor({state:'hidden'});
 }
 await page.setViewportSize({width:1280,height:900});
 results.push('notice first; info migration and keyboard; no history control or history fetch; green/red tiles');
 step='daily';await monthly();const day=button('2026-10-01 日別業務配置',page.locator('.candidate-monthly'));await day.click();await modal().getByRole('heading',{name:'2026-10-01の日別業務配置',exact:true}).waitFor();
 check(await modal().locator('.daily-person').count()===2,'DAILY_PEOPLE');await modal().getByLabel('対象日',{exact:true}).fill('2026-10-31');
 await modal().getByRole('heading',{name:'2026-10-31の日別業務配置',exact:true}).waitFor();check(await modal().locator('.daily-person').count()===1,'MONTH_END_ROWS');
 await button(person.name,modal()).click();const staffModal=page.locator('.staff-dialog-content:not(.schedule-detail-dialog)');
 await staffModal.getByRole('heading',{name:person.name+'の勤務一覧',exact:true}).waitFor();await button('勤務一覧を閉じる',staffModal).click();
 await staffModal.waitFor({state:'hidden'});check(await modal().isVisible(),'NESTED_LOST_DAILY');
 await page.keyboard.press('Escape');await modal().waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='2026-10-01 日別業務配置');
 step='cell';await cell(person,'2026-10-01').press('Enter');await modal().getByRole('heading',{name:person.name+' 2026-10-01の勤務詳細',exact:true}).waitFor();
 await modal().getByText('09:00〜11:00',{exact:true}).waitFor();await modal().getByText('90分',{exact:true}).waitFor();check(await modal().getByText('明示固定',{exact:true}).count()===1,'FIXED_MISSING');
 await close();await page.waitForFunction(label=>document.activeElement?.getAttribute('aria-label')===label,person.name+' 2026-10-01 勤務詳細');
 await cell(other,'2026-10-01').click();await modal().getByText('10:00〜12:00',{exact:true}).waitFor();await close();
 await cell(person,'2026-10-02').click();await modal().getByText('この日は勤務がありません。',{exact:true}).waitFor();await close();
 await cell(person,'2026-10-03').click();await modal().locator('dd').filter({hasText:'10:30〜11:00'}).waitFor();await close();
 const missing=page.locator('.candidate-monthly .month-table tbody tr').nth(1).locator('td').last();check(await missing.innerText()==='未確認'&&await missing.getByRole('button').count()===0,'MISSING_CLICKABLE');
 results.push('daily dates/month end and nested staff month dialog; distinct staff/day details; holiday/cancellation/missing; focus return');
 step='unsaved';const disclosure=page.locator('.draft-editor > details');await disclosure.locator('summary').click();const fixed=disclosure.getByRole('checkbox',{name:'勤務パターンを固定',exact:true,includeHidden:true});await fixed.check();
 await disclosure.locator('summary').click();await cell(person,'2026-10-01').click();check(await page.getByRole('alertdialog').count()===0,'READ_OPENED_UNSAVED_GUARD');await close();
 await disclosure.locator('summary').click();check(await fixed.isChecked(),'COLLAPSE_LOST_EDIT');await disclosure.locator('summary').click();
 await button('シフト計算の準備').click();await page.getByRole('alertdialog').waitFor();await button('編集を続ける',page.getByRole('alertdialog')).click();
 check(!await disclosure.evaluate(el=>el.open)&&await fixed.isChecked(),'HIDDEN_DIRTY_NOT_PROTECTED');
 results.push('editor initially collapsed, open/close and read modal preserve edits, hidden dirty form still guards navigation');
 step='responsive';for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});await cell(person,'2026-10-01').click();await modal().waitFor();
  const rect=await modal().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
  check(rect.left>=11&&rect.right<=width-11&&rect.top>=11&&rect.bottom<=889,'MODAL_OVERFLOW_'+width);
  await page.keyboard.press('Tab');check(await modal().evaluate(el=>el.contains(document.activeElement)),'FOCUS_ESCAPE_'+width);
  await page.screenshot({path:output+'/cell-'+width+'.png'});await close();
  await button('2026-10-01 日別業務配置',page.locator('.candidate-monthly')).click();await modal().waitFor();await page.screenshot({path:output+'/daily-'+width+'.png'});await close();
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'PAGE_OVERFLOW_'+width);
 }
 // Reload discards the fictional local draft and must not reopen a dialog.
 step='legacy-url';await load('&tab=daily');await page.locator('.candidate-monthly .month-table').waitFor();check(!new URL(page.url()).searchParams.has('tab'),'LEGACY_TAB');
 await cell(person,'2026-10-01').click();await page.reload();await page.locator('.candidate-monthly .month-table').waitFor();check(await modal().count()===0,'MODAL_RESTORED');
 step='sources';await state({manual:true,stale:true});await load('&tab=monthly');await cell(person,'2026-10-01').click();
 await modal().getByText('保存済みの編集案 ／ 閲覧用の詳細です。',{exact:true}).waitFor();await modal().locator('dd').filter({hasText:/^出退勤$/}).waitFor();await modal().getByText('この案には最新の変更が反映されていません。',{exact:true}).waitFor();await close();
 // A source change delivered while a detail is open must invalidate that dialog.
 await button('2026-10-01 日別業務配置',page.locator('.candidate-monthly')).click();await page.getByRole('button',{name:'計算した案',exact:true,includeHidden:true}).evaluate(el=>el.click());await modal().waitFor({state:'hidden'});
 results.push('PC/390/320 layout and focus trap; old URL migration; no modal restore; manual source/stale warning and source invalidation');
 step='states';await page.setViewportSize({width:1280,height:900});
 for(const status of ['ORIGINAL_VERIFIED','PENDING','RUNNING','FAILED','HISTORY_UNVERIFIED','INVALID','INPUT_INVALID']){
  await state({...defaults,status});await load();
  await tiles().nth(0).getByRole('status').waitFor();check(await tiles().nth(0).evaluate(el=>el.classList.contains('validation-good'))===(status==='ORIGINAL_VERIFIED'),'STATUS_COLOR_'+status);
  if(status==='ORIGINAL_VERIFIED')await tiles().nth(1).getByText('19800人分・分',{exact:true}).waitFor();
  if(['PENDING','RUNNING'].includes(status))check(await tiles().nth(1).getByText('再検証の完了待ち',{exact:true}).count()===1,'OLD_METRICS_'+status);
  if(status==='FAILED'){await button('再検証を再試行').click();await tiles().nth(0).getByText('最新条件での再検証待ち',{exact:true}).waitFor();}
 }
 for(const certificateMode of ['wrongPublication','wrongRevision','unadopted','missingMetric']){
  await state({...defaults,certificateMode});await load();await button('検証記録を再読込').waitFor();
  check(await tiles().nth(1).getByText('19800人分・分',{exact:true}).count()===0,'MISMATCH_METRICS_'+certificateMode);
 }
 await state({...defaults,certificateFailure:true});await load();await button('検証記録を再読込').waitFor();await state({certificateFailure:false,generalShortage:0,roleSameShortage:30});await button('検証記録を再読込').click();
 await tiles().nth(1).getByText('0人分・分',{exact:true}).waitFor();check(await tiles().nth(1).evaluate(el=>el.classList.contains('validation-good')),'GENERAL_ZERO');check(await tiles().nth(2).evaluate(el=>el.classList.contains('validation-danger')),'ROLE_SHORTAGE');
 results.push('all validation states; original publication metrics; retry; missing metric and mismatched publication/revision/adoption rejected; shortage colors independently checked');
 step='touch';await state(defaults);const touchContext=await page.context().browser().newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
 try{const touch=await touchContext.newPage();await touch.goto(origin+'/app?month=2026-10&tab=monthly');const tap=async locator=>{await locator.scrollIntoViewIfNeeded();const r=await locator.boundingBox();await touch.touchscreen.tap(r.x+r.width/2,r.y+r.height/2);};
  await tap(button('公開済みシフトの情報の説明',touch));await touch.getByRole('dialog',{name:'公開済みシフトの情報',exact:true}).waitFor();await tap(button('説明を閉じる',touch));
  await tap(button(`${other.name} 2026-10-01 勤務詳細`,touch.locator('.candidate-monthly')));await touch.locator('.schedule-detail-dialog').getByText('10:00〜12:00',{exact:true}).waitFor();
 }finally{await touchContext.close();}
 step='staff';await state({...defaults,role:'staff'});await page.goto(origin+'/app?month=2026-10');await page.locator('.published-days').waitFor();
 check(await page.locator('main .panel').first().getByRole('heading',{name:'自分へのシフトのお知らせ',exact:true}).count()===1,'STAFF_NOTICES');
 await button('公開済みシフトの情報の説明').click();const staffInfo=page.getByRole('dialog',{name:'公開済みシフトの情報',exact:true});await staffInfo.waitFor();check(!/入力版|公開元/.test(await staffInfo.innerText()),'STAFF_METADATA_LEAK');
 check(await page.locator('.publication-validation').count()===0,'STAFF_MANAGER_METRICS');check(errors.length===0,'PAGE_ERRORS_'+errors.join(','));
 results.push('real touch popup/cell modal; staff notice order and metadata permission');
 return {passed:true,results,widths:[1280,390,320],errors,scope:'real built UI, fictional loopback API; no solver or Cloudflare'};
 }catch(error){throw Error('SCHEDULE_DETAILS_STEP '+step+' '+error.message);}
}
