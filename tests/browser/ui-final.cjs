async(page,owner,stage)=>{
 const assert=(v,c)=>{if(!v)throw Error(c);},button=name=>page.getByRole('button',{name,exact:true});
 const base=`/api/companies/${owner.companyId}/inputs/teams/${owner.teamId}`,schedule=`/api/companies/${owner.companyId}/schedules/teams/${owner.teamId}`;
 const get=async route=>page.evaluate(async route=>{const r=await fetch(route);if(!r.ok)throw Error('READ_FAILED');return r.json();},route);
 const results=[];const passed=name=>results.push({name,passed:true});
 if(stage==='final-history'){
  await button('勤務履歴').click();await button('確認した履歴を保存').waitFor();
  const before=await get(base+'/history/'+owner.month);assert(before.missing.length>0,'NO_BOUNDARY_HISTORY');
  for(const r of before.missing){await page.getByRole('group',{name:r.date+'の勤務履歴',exact:true}).getByRole('spinbutton',{name:'勤務時間(分)',exact:true}).fill('0');await page.getByRole('group',{name:r.date+'の勤務履歴',exact:true}).getByRole('textbox',{name:'確認の根拠',exact:true}).fill('架空最終画面受入: 前月の休日を確認');}
  const response=page.waitForResponse(r=>r.url().endsWith('/history')&&r.request().method()==='POST');await button('確認した履歴を保存').click();const r=await response;assert(r.status()===200,'HISTORY_SAVE_FAILED');
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='確認した履歴を保存'&&!b.matches(':disabled')));
  const after=await get(base+'/history/'+owner.month);assert(after.missing.length===0,'HISTORY_MISSING');passed('normal UI confirms preceding-month0-minute history and reloads saved evidence');
  return {stage,companyId:owner.companyId,results,historyDays:before.missing.length,operationId:r.request().postDataJSON().operationId,inputRevision:after.inputRevision};
 }
 if(stage==='final-calculate'){
  await button('シフト・計算結果').click();await button('シフトを計算').waitFor();
  const response=page.waitForResponse(r=>r.url().endsWith('/jobs')&&r.request().method()==='POST');await button('シフトを計算').click();const r=await response;assert(r.status()===200||r.status()===202,'JOB_NOT_ACCEPTED');
  const accepted=await r.json(),job=accepted.job;assert(job&&job.id,'NO_JOB_ID');
  passed('one normal UI calculation acceptance uses actual job ID');return {stage,companyId:owner.companyId,results,jobId:job.id,acceptedState:job.state,operationId:r.request().postDataJSON().operationId};
 }
 if(stage==='final-tabs'){
  const jobId=await page.getByRole('combobox',{name:'計算履歴',exact:true}).inputValue();assert(jobId,'JOB_SELECTION_MISSING');
  const jobBase=`/api/companies/${owner.companyId}/compute/teams/${owner.teamId}/jobs/${jobId}`;
  const job=await get(jobBase),view=await get(jobBase+'/result');assert(job.state==='SUCCEEDED'&&job.attempt===1&&view.result.validation.status==='VERIFIED','JOB_NOT_VERIFIED');
  assert(view.result.assignments.length===31,'ASSIGNMENT_COUNT');
  await page.locator('.candidate-monthly .month-table').waitFor();
  await page.locator('.candidate-monthly').getByRole('button',{name:'2026-10-02 日別業務配置',exact:true}).waitFor();
  assert(await page.locator('.candidate-monthly .month-table tbody tr').count()===1,'MONTH_STAFF_SCOPE');assert(await page.locator('.candidate-monthly .month-table tbody td button').count()===31,'MONTH_DAYS');
  await page.screenshot({path:owner.artifact+'/ui-final-month-pc.png',fullPage:true});
  await page.locator('.candidate-monthly').getByRole('button',{name:'2026-10-02 日別業務配置',exact:true}).click();assert(await page.getByLabel('対象日',{exact:true}).inputValue()==='2026-10-02','MONTH_CELL_DAY');
  await button('詳細を閉じる').click();await button('計算結果').click();await page.getByRole('heading',{name:'不足人数',exact:true}).waitFor();
  assert(await page.getByText('有効案あり・最良値は未証明',{exact:true}).count()>=1,'UNPROVEN_STATUS_HIDDEN');assert(await page.getByText('対象条件の検証済み',{exact:true}).count()>=1,'VERIFICATION_STATUS_HIDDEN');
  await button('計算結果を閉じる').click();await button('計算結果').focus();
  const focus=await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return {name:e.textContent.trim(),outline:s.outlineWidth,style:s.outlineStyle};});assert(focus.name==='計算結果'&&parseFloat(focus.outline)>=2&&focus.style!=='none','KEYBOARD_FOCUS_MISSING');
  await page.keyboard.press('Enter');await page.getByRole('dialog',{name:'計算結果',exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'計算結果',exact:true}).waitFor({state:'hidden'});await page.locator('.candidate-monthly').getByRole('button',{name:'2026-10-02 日別業務配置',exact:true}).click();assert(await page.getByLabel('対象日',{exact:true}).inputValue()==='2026-10-02','TAB_DAY_RESET');
  assert(await page.getByRole('combobox',{name:'計算履歴',exact:true}).inputValue()===jobId,'TAB_JOB_RESET');assert(await page.getByRole('textbox',{name:'対象月',exact:true}).inputValue()===owner.month,'TAB_MONTH_RESET');
  await page.screenshot({path:owner.artifact+'/ui-final-daily-pc.png',fullPage:true});
  await button('詳細を閉じる').click();const unchanged=await get(jobBase+'/result');assert(JSON.stringify(unchanged.result)===JSON.stringify(view.result),'TAB_RESULT_MUTATED');passed('monthly and result modal preserve month/day/job;31-day table and API result remain identical');passed('keyboard Enter and Escape open and close results with a visible focus outline');
  return {stage,companyId:owner.companyId,results,jobId,solverStatus:job.solver_status,validationStatus:job.validation_status,attempt:job.attempt,assignmentCount:31,selectedDay:'2026-10-02',focus,calculationProfile:view.result.calculationProfile,metrics:view.result.metrics};
 }
 if(stage==='final-publish'){
  const before=await get(schedule+'/publications?month='+owner.month);assert(before.publication===null,'ALREADY_PUBLISHED');
  await button('シフトを公開').click();const response=page.waitForResponse(r=>new URL(r.url()).pathname===schedule+'/publications'&&r.request().method()==='POST');await button('再検証して公開').click();const r=await response;assert(r.status()===200,'PUBLICATION_FAILED');
  const receipt=await r.json();await button('公開済みシフトの情報の説明').focus();await page.getByText(/公開版1 ／/).waitFor();await page.keyboard.press('Escape');
  const head=await get(schedule+'/publications?month='+owner.month);assert(head.publicationRevision===1&&head.publication.assignments.length===31,'PUBLICATION_READ_MISMATCH');
  assert(head.publication.publicationId===r.request().postDataJSON().operationId,'PUBLICATION_OPERATION_MISMATCH');
  const jobId=await page.getByRole('combobox',{name:'計算履歴',exact:true}).inputValue(),view=await get(`/api/companies/${owner.companyId}/compute/teams/${owner.teamId}/jobs/${jobId}/result`);
  assert(JSON.stringify(head.publication.assignments)===JSON.stringify(view.result.assignments),'PUBLICATION_ASSIGNMENTS_CHANGED');
  await page.screenshot({path:owner.artifact+'/ui-final-published-pc.png',fullPage:true});passed('one real SDK recheck/publication preserves31 saved assignments and current version1');
  return {stage,companyId:owner.companyId,results,publicationId:head.publication.publicationId,publicationRevision:1,inputRevision:head.publication.appliedRevision,receipt,assignmentCount:31};
 }
 if(stage==='final-notices'){
  await page.setViewportSize({width:390,height:844});await page.getByRole('heading',{name:'自分の公開済みシフト',exact:true}).waitFor();
  const pubs=schedule+'/publications',before=await get(pubs+'?month='+owner.month),inbox=await get(pubs+'/notices');
  assert(before.publication.assignments.length===31&&before.publication.assignments.every(a=>a.staffId===owner.staffId),'SELF_ASSIGNMENTS_SCOPE');assert(inbox.notices.length===1&&inbox.notices[0].readAt===null,'SELF_NOTICE_NOT_UNREAD');
  for(const name of ['シフトを計算','再検証して公開','スタッフ管理','需要管理','企業共通ルール'])assert(await button(name).count()===0,'STAFF_MANAGER_ACTION_VISIBLE');
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:owner.artifact+'/ui-final-staff-publication-mobile.png'});
  const id=inbox.notices[0].publicationId,response=page.waitForResponse(r=>r.url().endsWith('/notices/'+id+'/read')&&r.request().method()==='POST');await button('既読にする').click();const r=await response;assert(r.status()===200,'NOTICE_READ_FAILED');
  await page.getByText('既読',{exact:true}).waitFor();const after=await get(pubs+'/notices');assert(after.notices[0].readAt!==null,'NOTICE_NOT_PERSISTED');
  await button('最新のお知らせを読み直す').click();await page.getByText('既読',{exact:true}).waitFor();assert((await get(pubs+'/notices')).notices[0].readAt===after.notices[0].readAt,'NOTICE_TIME_CHANGED');
  await button('対象の公開版を見る').click();await button('最新の公開版へ戻る').waitFor();const selected=await get(pubs+'/'+id);assert(selected.publication.publicationId===before.publication.publicationId,'NOTICE_OPEN_WRONG_VERSION');
  await page.getByRole('heading',{name:'自分へのシフトのお知らせ',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:owner.artifact+'/ui-final-staff-notice-mobile.png'});
  const denied=await page.evaluate(async route=>(await fetch(route)).status,pubs+'/export?month='+owner.month);assert(denied===403,'STAFF_EXPORT_ALLOWED');
  const geometry=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,padding:getComputedStyle(document.querySelector('.panel-body')).paddingLeft}));assert(geometry.width<=geometry.viewport,'STAFF_HORIZONTAL_OVERFLOW');
  passed('staff390px sees own31 days and own inbox; read state survives reload without changing timestamp');passed('notice opens the same publication; manager controls absent and export API403');
  return {stage,companyId:owner.companyId,results,staffId:owner.staffId,publicationId:id,publicationRevision:before.publicationRevision,noticeCount:1,readAt:after.notices[0].readAt,geometry};
 }
 if(stage==='final-csv'){
  const original=await get(schedule+'/publications?month='+owner.month),context=await get('/api/context'),revision=context.companies.find(c=>c.id===owner.companyId).revision;
  const target='2026-11';await page.getByRole('textbox',{name:'対象月',exact:true}).fill(target);await button('需要管理').click();await button('需要CSVの取り込み').click();await page.getByLabel('需要CSVファイル',{exact:true}).waitFor();
  const route=base+'/planning/'+target,before=await get(route);assert(before.version===null,'FUTURE_PLAN_NOT_EMPTY');
  const preview=async()=>{const response=page.waitForResponse(r=>r.url().endsWith('/demand-csv/preview')&&r.request().method()==='POST');await page.getByLabel('需要CSVファイル',{exact:true}).setInputFiles(owner.artifact+'/ui-final-demand.csv');const r=await response;assert(r.status()===200,'CSV_PREVIEW_FAILED');const p=await r.json();await page.getByRole('table',{name:'需要CSVプレビュー',exact:true}).waitFor();assert(p.added===2&&p.rows.length===3&&p.rows[1].line===3&&p.rows[1].errors.some(e=>e.column==='end'),'CSV_ROWS_DIAGNOSIS');return p;};
  const p=await preview();const table=page.getByRole('table',{name:'需要CSVプレビュー',exact:true});assert((await table.innerText()).includes('0 ／ 2.75')&&(await table.innerText()).includes('未設定 ／ 1.25'),'ZERO_UNSET_DISPLAY');assert((await table.locator('tbody tr').nth(1).innerText()).includes('end：'),'ROW_COLUMN_REASON_MISSING');
  await page.screenshot({path:owner.artifact+'/ui-final-csv-preview-pc.png',fullPage:true});await button('全件中止').click();assert(await table.count()===0,'CSV_ABORT_NOT_CLEARED');assert(JSON.stringify(await get(route))===JSON.stringify(before),'CSV_ABORT_MUTATED_PLAN');assert((await get('/api/context')).companies.find(c=>c.id===owner.companyId).revision===revision,'CSV_ABORT_MUTATED_REVISION');passed('future-month CSV identifies row3/end;0/precision/unset displayed; abort leaves data and revision unchanged');
  await preview();const response=page.waitForResponse(r=>r.url().endsWith('/demand-csv/apply')&&r.request().method()==='POST');await button('正常行だけ反映').click();const r=await response;assert(r.status()===200,'CSV_APPLY_FAILED');const receipt=await r.json();
  await button('需要CSVの取り込みを閉じる').click();await page.getByRole('heading',{name:'CSVの反映結果',exact:true}).waitFor();
  const saved=await get(route),payload=saved.version.payload;assert(payload.demand.length===2&&payload.demand[0].direct===0&&payload.demand[0].calculated===275&&payload.demand[1].direct===null&&payload.demand[1].calculated===125,'CSV_SAVED_VALUES');
  assert(JSON.stringify(await get(schedule+'/publications?month='+owner.month))===JSON.stringify(original),'FUTURE_CSV_CHANGED_PUBLISHED_MONTH');
  await page.screenshot({path:owner.artifact+'/ui-final-csv-applied-pc.png',fullPage:true});await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='需要CSVの取り込み'&&!b.matches(':disabled')));await page.reload();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='シフトを計算'&&!b.matches(':disabled')));await button('需要管理').click();await page.getByLabel('需要 1 直接必要人数（空欄＝未設定）',{exact:true}).waitFor();
  assert(await page.getByLabel('需要 1 直接必要人数（空欄＝未設定）',{exact:true}).inputValue()==='0','CSV_RELOAD_ZERO');assert(await page.getByLabel('需要 2 直接必要人数（空欄＝未設定）',{exact:true}).inputValue()==='','CSV_RELOAD_UNSET');
  assert(await page.getByRole('textbox',{name:'対象月',exact:true}).inputValue()===target,'CSV_MONTH_RESET');passed('normal rows apply to November once and reload exact values; October publication unchanged');
  return {stage,companyId:owner.companyId,results,targetMonth:target,previewRows:p.rows.length,validRows:2,errorLine:3,errorColumn:'end',inputRevision:saved.inputRevision,operationId:r.request().postDataJSON().operationId,receipt,publicationRevision:original.publicationRevision};
 }
 if(stage==='final-csv-confirm'){
  assert(await page.getByRole('textbox',{name:'対象月',exact:true}).inputValue()==='2026-11','CSV_CONFIRM_WRONG_MONTH');
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='シフトを計算'&&!b.matches(':disabled')));await button('需要管理').click();await page.getByLabel('需要 1 直接必要人数（空欄＝未設定）',{exact:true}).waitFor();
  const saved=await get(base+'/planning/2026-11'),context=await get('/api/context'),id=saved.version.id,receipt=await get(base+'/demand-csv/receipts/'+id);assert(id&&receipt.id===id&&receipt.importedRows===2&&receipt.rejectedRows===1,'CSV_CONFIRM_RECEIPT');
  assert(saved.version.payload.demand[0].direct===0&&saved.version.payload.demand[0].calculated===275&&saved.version.payload.demand[1].direct===null&&saved.version.payload.demand[1].calculated===125,'CSV_CONFIRM_SAVED');
  assert(await page.getByLabel('需要 1 直接必要人数（空欄＝未設定）',{exact:true}).inputValue()==='0'&&await page.getByLabel('需要 2 直接必要人数（空欄＝未設定）',{exact:true}).inputValue()==='','CSV_CONFIRM_RELOAD');
  const publication=await get(schedule+'/publications?month='+owner.month);assert(publication.publicationRevision===1&&publication.publication.assignments.length===31,'CSV_CONFIRM_PUBLICATION');
  await page.screenshot({path:owner.artifact+'/ui-final-csv-reloaded-pc.png',fullPage:true});passed('GET confirms the same saved CSV receipt with2 imported/1 rejected; exact0/unset/precision reload without POST replay');
  return {stage,companyId:owner.companyId,results,targetMonth:'2026-11',operationId:id,receipt,currentRevision:context.companies.find(c=>c.id===owner.companyId).revision,publicationId:publication.publication.publicationId,publicationRevision:1};
 }
 if(stage==='final-layout'){
  await page.getByRole('heading',{name:'需要管理',exact:true}).waitFor();const sizes=[];
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:width===1280?900:844});await page.evaluate(()=>scrollTo(0,0));
   const geometry=await page.evaluate(()=>{const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const bad=[...document.querySelectorAll('.field input,.field select,.field textarea')].filter(visible).filter(e=>!e.closest('.table-scroll')&&(e.getBoundingClientRect().left<0||e.getBoundingClientRect().right>innerWidth));return {viewport:innerWidth,width:document.documentElement.scrollWidth,padding:getComputedStyle(document.querySelector('.panel-body')).paddingLeft,overflowFields:bad.map(e=>e.closest('label')?.innerText??e.tagName)};});assert(geometry.width<=width&&geometry.overflowFields.length===0,'FORM_HORIZONTAL_OVERFLOW');sizes.push(geometry);
   await page.screenshot({path:owner.artifact+'/ui-final-demand-'+width+'.png'});
  }
  await page.setViewportSize({width:1280,height:900});const target=page.getByRole('textbox',{name:'対象月',exact:true});await target.focus();await page.keyboard.press('Tab');const focus=await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return {tag:e.tagName,label:e.getAttribute('aria-label')??e.closest('label')?.innerText??e.textContent,outline:s.outlineWidth,style:s.outlineStyle};});assert(parseFloat(focus.outline)>=2&&focus.style!=='none','FORM_KEYBOARD_FOCUS_MISSING');
  passed('PC1280/mobile390/320 demand forms keep padding and have no page or field overflow');passed('keyboard moves from month to a labelled form control with visible focus');
  return {stage,companyId:owner.companyId,results,sizes,focus};
 }
 if(stage==='final-style'){
  await page.reload();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='シフトを計算'&&!b.matches(':disabled')));await button('需要管理').click();await button('需要CSVの取り込み').click();await page.getByLabel('需要CSVファイル',{exact:true}).waitFor();
  await page.setViewportSize({width:320,height:844});await page.evaluate(()=>scrollTo(0,0));const geometry=await page.evaluate(()=>{const b=document.querySelector('.topbar > button'),s=getComputedStyle(b);return {viewport:innerWidth,width:document.documentElement.scrollWidth,whiteSpace:s.whiteSpace,flexShrink:s.flexShrink,buttonHeight:b.getBoundingClientRect().height};});assert(geometry.width<=320&&geometry.whiteSpace==='nowrap'&&geometry.flexShrink==='0','LOGOUT_WRAP_NOT_FIXED');await page.screenshot({path:owner.artifact+'/ui-final-demand-320-fixed.png'});passed('actual rebuilt CSS keeps logout on one line at320px without page overflow');
  await page.setViewportSize({width:1280,height:900});await page.getByRole('dialog',{name:'需要CSVの取り込み',exact:true}).getByRole('button',{name:'需要CSVの取り込みを閉じる',exact:true}).focus();let focus,steps=0;
  for(;steps<5;steps++){await page.keyboard.press('Tab');focus=await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return {tag:e.tagName,label:e.getAttribute('aria-label')??e.closest('label')?.innerText??e.textContent.trim(),outline:s.outlineWidth,style:s.outlineStyle};});if(focus.tag==='SUMMARY')break;}
  assert(focus?.tag==='SUMMARY'&&focus.label==='CSVの形式と業務ID'&&parseFloat(focus.outline)>0&&focus.style!=='none','KEYBOARD_HELP_FOCUS');await page.keyboard.press('Enter');assert(await page.locator('details[open]').count()>=1,'KEYBOARD_HELP_NOT_OPENED');await page.screenshot({path:owner.artifact+'/ui-final-help-keyboard-pc.png'});passed('Tab leaves the month segments and Enter opens named CSV help with visible focus');
  return {stage,companyId:owner.companyId,results,geometry,focus,tabSteps:steps+1};
 }
 throw Error('UI_FINAL_STAGE_NOT_IMPLEMENTED');
}
