async page => {
 page.setDefaultTimeout(15000);page.removeAllListeners('dialog');page.on('dialog',dialog=>dialog.accept());
 const origin='http://127.0.0.1:8799',output='output/playwright/published-monthly',errors=[],results=[];
 page.on('pageerror',error=>errors.push(error.message));
 const check=(value,code)=>{if(!value)throw Error(code);},button=(name,target=page)=>target.getByRole('button',{name,exact:true});
 const state=async value=>{const r=await page.request.post(origin+'/__test/state',{data:value});check(r.ok(),'STATE');return r.json();};
 const fixture=await(await page.request.get(origin+'/__test/fixture')).json();
 const defaults={role:'company_admin',stale:false,noCandidate:true,noPublication:false,manual:false,missing:false,readinessFailure:false,snapshotFailure:false,fixedFailure:false,publicationCycle:0,certificateFailure:false,certificateMode:'',generalShortage:19800,roleSameShortage:0,status:'VERIFIED',cycle:0,delay:0,writes:[],requests:{}};
 const published=()=>page.locator('.published-monthly'),modal=()=>page.locator('.schedule-detail-dialog');
 const cell=(person,date)=>button(person.name+' '+date+' 勤務詳細',published());
 const load=async()=>{await page.goto(origin+'/app?month=2026-10&tab=monthly');await published().locator('tbody tr').nth(1).waitFor();};
 const close=async()=>{await button('詳細を閉じる',modal()).click();await modal().waitFor({state:'hidden'});};
 let step='published-only';try{
 await state(defaults);await load();check((await page.locator('.publication-heading').innerText())==='公開済みのシフト','HEADING');
 check(await page.getByText('スタッフ名を押すと、公開済み勤務を確認できます。',{exact:true}).count()===0,'OLD_PEOPLE_LIST');check(await page.locator('.published-staff-links').count()===0,'OLD_LINKS');
 check(await published().locator('tbody tr').count()===2&&await published().locator('tbody td').count()===62,'MONTH_SHAPE');check(await page.locator('.candidate-monthly .month-table').count()===0,'NO_CANDIDATE');
 step='staff-day';const trigger=cell(fixture.staff[0],'2026-10-01');await trigger.press('Enter');await modal().getByText('09:30〜11:00',{exact:true}).waitFor();await modal().getByText('公開版2（現在の公開版） ／ 閲覧用の詳細です。',{exact:true}).waitFor();
 await modal().getByText('公開時の情報を読み込んでいます…',{exact:true}).waitFor({state:'hidden'});check(await modal().getByRole('alert').count()===0,'SOURCE_ERROR');await modal().locator('dd').filter({hasText:/^出退勤$/}).waitFor();
 await button('このスタッフの月間勤務を見る',modal()).click();const staffModal=page.locator('.staff-dialog-content:not(.schedule-detail-dialog)');
 await staffModal.getByText('公開版2（現在の公開版）',{exact:true}).waitFor();await staffModal.getByRole('heading',{name:'公開勤務の明示固定',exact:true}).waitFor();await button('勤務一覧を閉じる',staffModal).click();await staffModal.waitFor({state:'hidden'});await close();check(await trigger.evaluate(el=>el===document.activeElement),'CELL_FOCUS');
 await cell(fixture.staff[0],'2026-10-02').click();await modal().getByText('この日は勤務がありません。',{exact:true}).waitFor();await close();
 await cell(fixture.staff[0],'2026-10-03').click();await modal().locator('dd').filter({hasText:/^10:30〜11:00$/}).waitFor();await close();
 const missing=published().locator('tbody tr').nth(1).locator('td').last();check(await missing.innerText()==='未確認'&&await missing.getByRole('button').count()===0,'MISSING_RECORD');
 step='daily';await button('2026-10-31 日別業務配置',published()).click();await modal().getByRole('heading',{name:'日別業務配置（公開済み）',exact:true}).waitFor();check(await modal().locator('.daily-person').count()===1,'LAST_DAY');
 await modal().getByLabel('対象日',{exact:true}).fill('2026-10-01');check(await modal().locator('.daily-person').count()===2,'DAY_CHANGE');await close();
 results.push('published month with no candidate; saved times, holiday/cancellation/missing; date modal; exact frozen context; current explicit fixed; nested monthly and focus');
 step='history';const history=page.locator('details').filter({has:page.locator('summary').filter({hasText:'公開履歴'})}).first();await history.locator(':scope > summary').click();await button('公開版1を表示',history).click();await published().waitFor();
 await cell(fixture.staff[1],'2026-10-01').click();await modal().getByText('公開版1（過去の公開版・閲覧のみ） ／ 閲覧用の詳細です。',{exact:true}).waitFor();await button('このスタッフの月間勤務を見る',modal()).click();await staffModal.getByText('公開版1（過去の公開版・閲覧のみ）',{exact:true}).waitFor();check(await staffModal.getByRole('heading',{name:'公開勤務の明示固定',exact:true}).count()===0,'HISTORICAL_FIXED_WRITE');await button('勤務一覧を閉じる',staffModal).click();await close();
 await button('最新の公開版へ戻る').click();await published().waitFor();
 results.push('past version table/detail/monthly read only; return to current version');
 step='failures';await state({snapshotFailure:true,fixedFailure:true});await cell(fixture.staff[0],'2026-10-01').click();await modal().getByRole('alert').waitFor();await modal().getByText('09:30〜11:00',{exact:true}).waitFor();await modal().locator('dd').filter({hasText:/^取得できていません$/}).waitFor();
 await state({snapshotFailure:false,fixedFailure:false});await button('公開時の情報を再読込',modal()).click();await modal().getByRole('alert').waitFor({state:'hidden'});await close();
 step='both-sources';await state({noCandidate:false});await load();await page.locator('.candidate-monthly .month-table').waitFor();check(await page.locator('.candidate-monthly .month-table').count()===1&&await published().locator('.month-table').count()===1,'BOTH_TABLES');
 check(await page.locator('.alert').filter({hasText:/^計算完了$/}).count()===0,'SUCCESS_BANNER_REMAINS');
 await cell(fixture.staff[0],'2026-10-01').click();await modal().getByText('09:30〜11:00',{exact:true}).waitFor();await close();await button(fixture.staff[0].name+' 2026-10-01 勤務詳細',page.locator('.candidate-monthly')).click();await modal().getByText('09:00〜11:00',{exact:true}).waitFor();await close();
 step='responsive';for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});await published().scrollIntoViewIfNeeded();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'PAGE_OVERFLOW_'+width);await page.screenshot({path:output+'/month-'+width+'.png'});
 await cell(fixture.staff[1],'2026-10-01').click();await modal().getByText('10:30〜12:00',{exact:true}).waitFor();await page.screenshot({path:output+'/cell-'+width+'.png'});await close();}
 results.push('metadata failure fallback/retry; published versus candidate data; no success banner; PC/390/320 responsive month and cell');
 step='publication-change';await state({...defaults,status:'PENDING'});await load();await cell(fixture.staff[0],'2026-10-01').click();await modal().waitFor();await state({publicationCycle:1});await modal().waitFor({state:'hidden'});check(await published().count()===1,'PUBLICATION_CHANGE_LOST_TABLE');results.push('publication replacement closes old detail and aborts its resource reads');
 step='staff';await state({role:'staff',publicationCycle:0,status:'VERIFIED'});await page.goto(origin+'/app?month=2026-10');await page.locator('.published-days').waitFor();check(await published().count()===0,'STAFF_TEAM_TABLE');check(await page.locator('.candidate-monthly').count()===0,'STAFF_CANDIDATE');
 check(!(await state({})).writes.length,'UNEXPECTED_WRITES');check(!errors.length,'PAGE_ERRORS');
 results.push('staff self-only display and no business writes');
 return {passed:true,results,widths:[1280,390,320],errors,scope:'real built UI with fictional loopback API; no solver or Cloudflare'};
 }catch(error){throw Error('PUBLISHED_MONTHLY_STEP '+step+' '+error.message);}
}
