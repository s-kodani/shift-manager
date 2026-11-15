async(page,action)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 const read=async(route)=>page.evaluate(async route=>{const r=await fetch(route);if(r.status!==200)throw Error('READ_'+r.status);return r.json();},route);
 const company=url.searchParams.get('company'),team=url.searchParams.get('team'),base='/api/companies/'+company+'/schedules/teams/'+team;
 const head=()=>read(base+'/publications?month=2026-10'),records=()=>read(base+'/leave?month=2026-10');
 const state=await page.evaluate(()=>window.__halfDaySdk??null);
 const store=async(value)=>page.evaluate(value=>{window.__halfDaySdk=value;},value);
 const key=a=>a.staffId+'|'+a.date;
 const card=part=>page.locator('.leave-records article').filter({has:page.getByRole('heading',{name:'2026-10-01 · '+(part==='AM'?'午前 · 休暇申請':'午後 · 欠勤事実'),exact:true})});
 const preflight=async(part)=>{
  const c=card(part),waiting=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/cancellation-check'),{timeout:90000});
  await c.getByRole('button',{name:'取消後の条件を確認',exact:true}).click();const r=await waiting,body=await r.json();if(r.status()!==200)throw Error('CANCELLATION_CHECK_'+r.status());return body;
 };
 if(action==='calendar'){
  await page.getByRole('button',{name:'企業共通ルール',exact:true}).click();await page.getByRole('combobox',{name:'午前・午後の境界時刻',exact:true}).selectOption('630');
  const waiting=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/calendar-settings'));
  await page.getByRole('button',{name:'カレンダー設定を保存',exact:true}).click();const r=await waiting;if(r.status()!==200)throw Error('CALENDAR_SAVE_'+r.status());
  const calendar=await read('/api/companies/'+company+'/calendar-settings/2026-10');return {status:200,calendar};
 }
 if(action==='staff-am'){
  const p=await head();if(p.publicationRevision!==1||p.publication.assignments.length!==31)throw Error('OWN_PUBLICATION_REQUIRED');
  await page.getByRole('button',{name:'休暇・欠勤',exact:true}).click();await page.getByRole('combobox',{name:'受付の種類',exact:true}).selectOption('LEAVE_REQUEST');
  await page.getByRole('combobox',{name:'対象の公開勤務',exact:true}).selectOption('2026-10-01');await page.getByRole('combobox',{name:'対象範囲',exact:true}).selectOption('AM');
  await page.getByRole('textbox',{name:'申請・記録の理由',exact:true}).fill('架空の午前休暇。研修参加解除と自動休憩の境界検証');
  const waiting=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/leave'));await page.getByRole('button',{name:'申請を送信',exact:true}).click();const r=await waiting,receipt=await r.json();if(r.status()!==200)throw Error('AM_SUBMISSION_'+r.status());return {status:200,receipt};
 }
 if(action==='pm-record'){
  const p=await head();if(p.publicationRevision!==1||p.publication.assignments.length!==3131)throw Error('BASE_PUBLICATION_REQUIRED');
  const candidates=p.publication.assignments.filter(a=>a.date==='2026-10-01'&&a.shift?.start===540&&a.shift.end===720&&a.shift.breakKind==='auto'&&JSON.stringify(a.shift.break)==='[570,600]');
  await page.getByRole('button',{name:'休暇・欠勤',exact:true}).click();
  const context=await read(base+'/leave/context?month=2026-10'),person=context.staff.find(s=>s.staffNumber==='fixture-0001');if(!person||context.halfDayDivider!==630||!candidates.some(a=>a.staffId===person.id))throw Error('EXPECTED_TARGET_SHIFT_MISSING');
  await store({original:p.publication,targetId:person.id,base,stage:'BEFORE_PM_RECORD'});
  await page.getByRole('combobox',{name:'受付の種類',exact:true}).selectOption('ABSENCE_FACT');await page.getByRole('combobox',{name:'欠勤したスタッフ',exact:true}).selectOption(person.id);
  await page.getByRole('combobox',{name:'対象の公開勤務',exact:true}).selectOption('2026-10-01');await page.getByRole('combobox',{name:'対象範囲',exact:true}).selectOption('PM');
  await page.getByRole('textbox',{name:'申請・記録の理由',exact:true}).fill('架空の午後実欠勤。事実と休憩矛盾による取消未確定を検証');
  const waiting=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/leave'));await page.getByRole('button',{name:'欠勤事実を記録',exact:true}).click();const r=await waiting,receipt=await r.json();if(r.status()!==200||receipt.status!=='REPORTED')throw Error('ABSENCE_FACT_FAILED');
  const original=await head();if(JSON.stringify(original.publication)!==JSON.stringify(p.publication))throw Error('FACT_AUTO_CANCELLED');
  const next=await page.evaluate(()=>window.__halfDaySdk);next.pmRequestId=receipt.requestId;next.stage='REPORTED';await store(next);return {status:200,receipt,publicationUnchanged:true};
 }
 if(!state)throw Error('SAME_BROWSER_SCENARIO_REQUIRED');
 if(action==='pm-invalid'){
  const check=await preflight('PM');if(check.validation.status!=='INVALID'||!check.validation.violations.some(v=>v.startsWith('BREAK_QUANTITY')))throw Error('EXPECTED_AUTO_BREAK_REFUSAL');
  await card('PM').getByText('取消候補に必須条件の違反があります',{exact:true}).waitFor();if(await card('PM').getByRole('button',{name:'欠勤取消を確定',exact:true}).count())throw Error('INVALID_COMMIT_BUTTON_PRESENT');
  const p=await head(),l=await records();if(JSON.stringify(p.publication)!==JSON.stringify(state.original)||l.records.find(r=>r.id===state.pmRequestId)?.status!=='REPORTED')throw Error('INVALID_CHECK_MUTATED_STATE');
  state.stage='PM_INVALID';await store(state);return {status:200,validationStatus:check.validation.status,violations:check.validation.violations,commitButtonAbsent:true,publicationUnchanged:true};
 }
 if(action==='am-commit'||action==='pm-commit'){
  const part=action==='am-commit'?'AM':'PM',prior=await head(),expected=part==='AM'?1:2;
  if(prior.publicationRevision!==expected)throw Error('EXPECTED_CURRENT_PUBLICATION');
  await page.getByRole('button',{name:'最新の受付を読み直す',exact:true}).click();const check=await preflight(part);if(check.validation.status!=='VERIFIED'||check.approval!=='NOT_COMMITTED')throw Error('EXPECTED_VALID_CHECK');
  if(check.removedParticipations.length!==(part==='AM'?1:0))throw Error('PARTICIPATION_REMOVAL_MISMATCH');
  const c=card(part);await c.getByText('確認した取消候補は検証済み・未確定',{exact:true}).waitFor();const ack=c.getByRole('checkbox',{name:'必要人数・担当区分の不足を確認し、この取消を確定する',exact:true});if(await ack.count())await ack.check();
  const waiting=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/cancellation-commit'),{timeout:90000});
  await c.getByRole('button',{name:part==='AM'?'申請を承認して勤務取消を確定':'欠勤取消を確定',exact:true}).click();const r=await waiting,receipt=await r.json();
  if(r.status()!==200||receipt.status!==(part==='AM'?'APPROVED':'CANCELLATION_CONFIRMED'))throw Error('COMMIT_FAILED_'+r.status());
  const current=await head(),old=new Map(prior.publication.assignments.map(a=>[key(a),a]));let target=null,unchanged=0;
  for(const row of current.publication.assignments){const before=old.get(key(row));if(!before)throw Error('ROW_ID_CHANGED');if(row.staffId===state.targetId&&row.date==='2026-10-01')target=row;else{if(JSON.stringify(row)!==JSON.stringify(before))throw Error('UNRELATED_WORK_CHANGED');unchanged++;}}
  if(!target||unchanged!==3130||current.publicationRevision!==expected+1||JSON.stringify([target.shift.start,target.shift.end,target.shift.breakKind,target.shift.break])!=='[540,720,"auto",[570,600]]')throw Error('PUBLICATION_FIELDS_CHANGED');
  if(target.shift.workedMinutes!==(part==='AM'?90:0)||JSON.stringify(target.shift.cancelled)!==(part==='AM'?'[[540,630]]':'[[540,720]]'))throw Error('REMAINING_WORK_MISMATCH');
  state.stage=part==='AM'?'AM_APPROVED':'PM_CONFIRMED';state.cancelledPublication=current.publication;await store(state);
  return {receipt,preflight:{status:check.validation.status,removedParticipations:check.removedParticipations},publicationRevision:current.publicationRevision,rows:current.publication.assignments.length,unchangedRows:unchanged,targetShift:target.shift,targetBlocks:target.blocks};
 }
 if(action==='reallocate'){
  await page.getByRole('button',{name:'シフト・計算結果',exact:true}).click();const p=await head();if(p.publicationRevision!==3)throw Error('EXPECTED_CANCELLED_PUBLICATION');
  state.stage='REALLOCATION_DISPATCHING';await store(state);const accepted=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/jobs'),{timeout:30000});await page.getByRole('button',{name:'シフトを計算',exact:true}).click();const ar=await accepted,a=await ar.json();if(ar.status()!==202)throw Error('REALLOCATION_ACCEPT_'+ar.status());state.reallocationJobId=a.job.id;state.stage='REALLOCATION_ACCEPTED';await store(state);
  const response=await page.waitForResponse(r=>r.url().endsWith('/jobs/'+a.job.id+'/result')&&r.status()===200,{timeout:180000}),b=await response.json();
  if(b.result.validation.status!=='VERIFIED'||b.result.assignments.length!==3131)throw Error('REALLOCATION_NOT_VERIFIED');
  const old=new Map(state.cancelledPublication.assignments.map(a=>[key(a),a.shift]));for(const row of b.result.assignments)if(JSON.stringify(row.shift)!==JSON.stringify(old.get(key(row))))throw Error('PUBLISHED_SHIFT_CHANGED');
  const now=await head();if(now.publicationRevision!==3||now.publication.publicationId!==p.publication.publicationId)throw Error('REALLOCATION_AUTO_PUBLISHED');
  state.stage='REALLOCATION_VERIFIED';await store(state);return {jobId:a.job.id,solverStatus:b.result.solverStatus,validationStatus:b.result.validation.status,rows:b.result.assignments.length,allShiftsPreserved:true,publicationRevision:3};
 }
 if(action==='republish'){
  if(state.stage!=='REALLOCATION_VERIFIED')throw Error('VERIFIED_REALLOCATION_REQUIRED');await page.getByRole('button',{name:'シフトを公開',exact:true}).click();const ack=page.getByRole('checkbox',{name:'必要人数・担当区分の不足が残っています。 不足を確認し、この案を公開する',exact:true});if(await ack.count())await ack.check();
  const waiting=page.waitForResponse(r=>r.request().method()==='POST'&&/\/publications$/.test(new URL(r.url()).pathname),{timeout:90000});await page.getByRole('button',{name:'再検証して公開',exact:true}).click();const r=await waiting,receipt=await r.json();if(r.status()!==200)throw Error('REPUBLISH_'+r.status());
  const p=await head();if(p.publicationRevision!==4||p.publication.assignments.length!==3131)throw Error('REPUBLISHED_HEAD_MISMATCH');const old=new Map(state.cancelledPublication.assignments.map(a=>[key(a),a.shift]));for(const row of p.publication.assignments)if(JSON.stringify(row.shift)!==JSON.stringify(old.get(key(row))))throw Error('REPUBLISH_CHANGED_SHIFT');state.stage='COMPLETE';await store(state);return {status:200,receipt,publicationRevision:4,rows:3131,allShiftsPreserved:true};
 }
 throw Error('UNKNOWN_SCENARIO_ACTION');
}
