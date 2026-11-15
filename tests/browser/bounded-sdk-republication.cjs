async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 const before=await page.evaluate(async()=>{
  const u=new URL(location.href),base='/api/companies/'+u.searchParams.get('company')+'/schedules/teams/'+u.searchParams.get('team'),head=await(await fetch(base+'/publications?month=2026-10')).json();
  if(head.publicationRevision!==2||head.publication.assignments.length!==15500)throw Error('EXPECTED_PUBLICATION_TWO');
  return {base,rows:head.publication.assignments.map(a=>({staffId:a.staffId,date:a.date,shift:a.shift}))};
 });
 const jobId=await page.getByRole('combobox',{name:'計算履歴',exact:true}).inputValue(),warning=page.getByRole('checkbox',{name:'必要人数・担当区分の不足が残っています。 不足を確認し、この案を公開する',exact:true});
 await page.getByRole('button',{name:'シフトを公開',exact:true}).click();
 if(await warning.count()){if(!await page.getByRole('button',{name:'再検証して公開',exact:true}).isDisabled())throw Error('SHORTAGE_ACK_GATE_MISSING');await warning.check();}
 const started=Date.now(),pending=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/publications'),{timeout:90000});
 await page.getByRole('button',{name:'再検証して公開',exact:true}).click();const response=await pending,command=response.request().postDataJSON(),receipt=await response.json();
 if(response.status()!==200||receipt.publicationRevision!==3||command.source.kind!=='job'||command.source.id!==jobId)throw Error('SEPARATE_REPUBLICATION_FAILED');
 const proof=await page.evaluate(async({before,command})=>{
  const head=await(await fetch(before.base+'/publications?month=2026-10')).json(),saved=await(await fetch(before.base+'/publications/'+command.operationId)).json(),csv=await fetch(before.base+'/publications/export?month=2026-10'),lines=(await csv.text()).trimEnd().split('\n');
  const key=a=>a.staffId+'|'+a.date,old=new Map(before.rows.map(a=>[key(a),a.shift]));
  if(head.publicationRevision!==3||saved.publication.assignments.length!==15500||saved.publication.validation.status!=='VERIFIED'||csv.status!==200||lines.length!==15501)throw Error('REPUBLICATION_PROOF_MISMATCH');
  for(const a of saved.publication.assignments)if(!old.has(key(a))||JSON.stringify(a.shift)!==JSON.stringify(old.get(key(a))))throw Error('REPUBLICATION_SHIFT_CHANGED');
  const replay=await fetch(before.base+'/publications',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(command)}),replayed=await replay.json(),after=await(await fetch(before.base+'/publications?month=2026-10')).json();
  if(replay.status!==200||!replayed.replayed||replayed.publicationRevision!==3||after.publicationRevision!==3)throw Error('REPUBLICATION_REPLAY_MISMATCH');
  return {publicationId:command.operationId,publicationRevision:head.publicationRevision,rows:saved.publication.assignments.length,shiftRowsCompared:old.size,objectiveVector:saved.publication.validation.objectiveVector,csvLines:lines.length,csvStatus:csv.status,replay:{status:replay.status,replayed:replayed.replayed,publicationRevision:after.publicationRevision}};
 },{before,command});
 return {jobId,publicationMillis:Date.now()-started,receipt,proof};
}
