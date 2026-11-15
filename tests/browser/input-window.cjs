async(page,owner,stage)=>{
 const results=[],b=name=>page.getByRole('button',{name,exact:true}),base=`/api/companies/${owner.companyId}/inputs/teams/${owner.teamId}`;
 await b('勤務不可・希望').click();await page.getByRole('heading',{name:'このチームの受付再開',exact:true}).waitFor();
 const before=await page.evaluate(async route=>await(await fetch(route)).json(),base+'/submission-window/'+owner.month);
 if(before.deadline.deadlineDate!=='2026-09-30')throw Error('DEADLINE_MONTH_END_NOT_CORRECTED');
 const pending=page.waitForResponse(r=>r.url().endsWith('/submission-window/'+owner.month)&&r.request().method()==='POST');
 if(stage==='window-open'){
  if(before.window)throw Error('WINDOW_ALREADY_EXISTS');
  const until=new Date(Date.now()+10*60_000+9*60*60_000).toISOString().slice(0,16);await page.getByLabel('追加受付の終了日（日本時間）',{exact:true}).fill(until.slice(0,10));await page.getByLabel('追加受付の終了時刻（HHMM・日本時間）',{exact:true}).fill(until.slice(11).replace(':',''));await b('この日時まで受付を再開').click();
 }else{if(!before.window?.closesAt)throw Error('NO_OPEN_WINDOW');await b('追加受付を終了').click();}
 const r=await pending;if(r.status()!==200)throw Error('WINDOW_SAVE_FAILED');const receipt=await r.json();
 await page.waitForFunction(()=>![...document.querySelectorAll('input')].find(e=>e.placeholder==='HHMM').matches(':disabled'));
 const after=await page.evaluate(async route=>await(await fetch(route)).json(),base+'/submission-window/'+owner.month);
 if(after.window.revision!==before.window?.revision+1&&!(stage==='window-open'&&after.window.revision===1))throw Error('WINDOW_REVISION_MISMATCH');
 if(stage==='window-close'&&after.window.closesAt!==null)throw Error('WINDOW_NOT_CLOSED');
 results.push({name:'UI '+stage+' uses separate window revision and preceding-month September31 corrected to30',passed:true});
 return {stage,companyId:owner.companyId,results,receipt,before,after,operationId:r.request().postDataJSON().operationId,status:r.status(),cloudflareRequests:0};
}
