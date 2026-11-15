async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 const jobId=await page.getByRole('combobox',{name:'計算履歴',exact:true}).inputValue();
 await page.getByRole('button',{name:'シフトを公開',exact:true}).click();
 const warning=page.getByRole('checkbox',{name:'必要人数・担当区分の不足が残っています。 不足を確認し、この案を公開する',exact:true});
 let rejected=null;
 if(await warning.count()){
  if(!await page.getByRole('button',{name:'再検証して公開',exact:true}).isDisabled())throw Error('SHORTAGE_UI_ACK_GATE_MISSING');
  rejected=await page.evaluate(async jobId=>{
   const u=new URL(location.href),company=u.searchParams.get('company'),team=u.searchParams.get('team'),prefix='/api/companies/'+company;
   const base=prefix+'/schedules/teams/'+team+'/publications',source=await(await fetch(prefix+'/compute/teams/'+team+'/jobs/'+jobId+'/result')).json();
   const before=await(await fetch(base+'?month=2026-10')).json(),draft=await(await fetch(prefix+'/schedules/teams/'+team+'/drafts?month=2026-10')).json();
   const response=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId:crypto.randomUUID(),expectedRevision:source.result.inputVersion,expectedDraftRevision:draft.draftRevision,expectedPublicationRevision:before.publicationRevision,source:{kind:'job',id:jobId},acknowledgeShortage:false})});
   const error=await response.json(),after=await(await fetch(base+'?month=2026-10')).json();
   if(response.status!==400||error.error!=='PUBLICATION_SHORTAGE_ACK_REQUIRED'||before.publicationRevision!==0||after.publicationRevision!==0)throw Error('SHORTAGE_API_ACK_GATE_MISSING');
   return {status:response.status,error:error.error,before:before.publicationRevision,after:after.publicationRevision};
  },jobId);
  await warning.check();
 }
 const started=Date.now(),pending=page.waitForResponse(r=>r.request().method()==='POST'&&/\/publications$/.test(r.url())&&r.status()===200,{timeout:60000});
 await page.getByRole('button',{name:'再検証して公開',exact:true}).click();
 const response=await pending,command=response.request().postDataJSON(),receipt=await response.json();
 await page.getByRole('link',{name:'公開済み勤務のCSVをダウンロード',exact:true}).waitFor();
 const proof=await page.evaluate(async id=>{
  const u=new URL(location.href),base='/api/companies/'+u.searchParams.get('company')+'/schedules/teams/'+u.searchParams.get('team')+'/publications';
  const published=await(await fetch(base+'/'+id)).json(),head=await(await fetch(base+'?month=2026-10')).json(),csv=await fetch(base+'/export?month=2026-10');
  const lines=(await csv.text()).trimEnd().split('\n');
  if(published.publication.assignments.length!==15500||published.publication.validation.status!=='VERIFIED'||head.publicationRevision!==1||csv.status!==200||lines.length!==15501)throw Error('PUBLICATION_PROOF_MISMATCH');
  return {id,publicationRevision:head.publicationRevision,rows:published.publication.assignments.length,objectiveVector:published.publication.validation.objectiveVector,csvStatus:csv.status,csvLines:lines.length,csvHeader:lines[0]};
 },command.operationId);
 return {jobId,rejected,publicationMilliseconds:Date.now()-started,receipt,proof};
}
