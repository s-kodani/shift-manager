async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 const before=await page.evaluate(async()=>{
  const u=new URL(location.href),base='/api/companies/'+u.searchParams.get('company')+'/schedules/teams/'+u.searchParams.get('team'),head=await(await fetch(base+'/publications?month=2026-10')).json(),leaves=await(await fetch(base+'/leave?month=2026-10')).json();
  if(head.publicationRevision!==1||leaves.records.length!==1||leaves.records[0].status!=='PENDING')throw Error('EXPECTED_PENDING_LEAVE_AND_PUBLICATION_ONE');
  const published=await(await fetch(base+'/publications/'+head.publication.publicationId)).json();
  return {base,record:leaves.records[0],publication:published.publication};
 });
 await page.getByRole('button',{name:'休暇・欠勤',exact:true}).click();
 const card=page.locator('.leave-records article').filter({has:page.getByRole('heading',{name:'2026-10-02 · 全日 · 休暇申請',exact:true})});
 const blocked=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/cancellation-check'),{timeout:30000});
 await card.getByRole('button',{name:'取消後の条件を確認',exact:true}).click();const denied=await blocked,error=await denied.json();
 if(denied.status()<400||error.error!=='LEAVE_FIXED_RELEASE_REQUIRED'||await card.getByRole('button',{name:'申請を承認して勤務取消を確定',exact:true}).count())throw Error('FIXED_RELEASE_GATE_MISSING');
 await page.getByRole('button',{name:'シフト・計算結果',exact:true}).click();
 await page.locator('.published-monthly').getByRole('button',{name:'架空スタッフ0001',exact:true}).click();
 await page.getByRole('combobox',{name:'固定を解除する勤務日',exact:true}).selectOption('2026-10-02');
 for(const name of['勤務パターンの固定を解除','出退勤の固定を解除','休憩の固定を解除'])await page.getByRole('checkbox',{name,exact:true}).check();
 const released=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/fixed/release'),{timeout:30000});
 await page.getByRole('button',{name:'選択した固定を解除',exact:true}).click();const releaseResponse=await released,releaseReceipt=await releaseResponse.json();if(releaseResponse.status()!==200)throw Error('FIXED_RELEASE_FAILED');
 await page.getByText('選択した固定を解除しました。公開済みの勤務時刻・休憩は維持しています。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'勤務一覧を閉じる',exact:true}).click();
 await page.getByRole('button',{name:'休暇・欠勤',exact:true}).click();
 const checked=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/cancellation-check'),{timeout:90000});
 await card.getByRole('button',{name:'取消後の条件を確認',exact:true}).click();const checkResponse=await checked,check=await checkResponse.json();
 if(checkResponse.status()!==200||check.validation.status!=='VERIFIED'||check.approval!=='NOT_COMMITTED')throw Error('CANCELLATION_CHECK_FAILED');
 const warning=card.getByRole('checkbox',{name:'必要人数・担当区分の不足を確認し、この取消を確定する',exact:true});if(await warning.count())await warning.check();
 const committed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/cancellation-commit'),{timeout:90000});
 await card.getByRole('button',{name:'申請を承認して勤務取消を確定',exact:true}).click();const commitResponse=await committed,receipt=await commitResponse.json();if(commitResponse.status()!==200||receipt.status!=='APPROVED'||receipt.publicationRevision!==2)throw Error('CANCELLATION_COMMIT_FAILED');
 const proof=await page.evaluate(async before=>{
  const head=await(await fetch(before.base+'/publications?month=2026-10')).json(),saved=await(await fetch(before.base+'/publications/'+head.publication.publicationId)).json(),old=before.publication.assignments,rows=saved.publication.assignments;
  if(head.publicationRevision!==2||rows.length!==15500)throw Error('CANCELLATION_HEAD_MISMATCH');
  const key=a=>a.staffId+'|'+a.date,map=new Map(old.map(a=>[key(a),a]));let unchanged=0,target=null;
  for(const row of rows){const prior=map.get(key(row));if(!prior)throw Error('CANCELLATION_ROW_ID_MISMATCH');if(row.staffId===before.record.staffId&&row.date===before.record.date){target=row;if(row.shift.start!==prior.shift.start||row.shift.end!==prior.shift.end||row.shift.breakKind!==prior.shift.breakKind||JSON.stringify(row.shift.break)!==JSON.stringify(prior.shift.break)||row.shift.workedMinutes!==0||JSON.stringify(row.shift.cancelled)!=='[[540,720]]'||row.blocks.length)throw Error('CANCELLED_SHIFT_MISMATCH');}else{if(JSON.stringify(row)!==JSON.stringify(prior))throw Error('UNRELATED_ASSIGNMENT_CHANGED');unchanged++;}}
  if(!target||unchanged!==15499)throw Error('CANCELLATION_TARGET_MISSING');
  const detail=await(await fetch(before.base+'/leave/'+before.record.id)).json();
  return {publicationId:head.publication.publicationId,publicationRevision:head.publicationRevision,rows:rows.length,unchangedRows:unchanged,targetShift:target.shift,request:detail};
 },before);
 return {blocked:{status:denied.status(),error:error.error},releaseReceipt,check:{status:check.validation.status,approval:check.approval,removedParticipations:check.removedParticipations.length,objectiveVector:check.validation.objectiveVector},receipt,proof};
}
