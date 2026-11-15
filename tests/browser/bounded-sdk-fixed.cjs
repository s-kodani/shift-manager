async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 const previous=await page.evaluate(async()=>{
  const u=new URL(location.href),base='/api/companies/'+u.searchParams.get('company')+'/schedules/teams/'+u.searchParams.get('team'),head=await(await fetch(base+'/drafts?month=2026-10')).json(),d=head.draft;
  if(head.draftRevision!==1||d.validation.status!=='VERIFIED'||d.assignments.length!==15500||d.locks.length!==1||d.exceptions.length!==1)throw Error('EXPECTED_FULL_EDITED_DRAFT');
  const lock=d.locks[0],a=d.assignments.find(a=>a.staffId===lock.staffId&&a.date===lock.date);
  return {draftId:d.draftId,draftRevision:head.draftRevision,lock,exception:d.exceptions[0],shift:a.shift,objectiveVector:d.validation.objectiveVector};
 });
 const started=Date.now(),acceptedResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/jobs')&&r.status()===202,{timeout:30000});
 await page.getByRole('button',{name:'シフトを計算',exact:true}).click();
 const accepted=await(await acceptedResponse).json(),jobId=accepted.job.id;
 const response=await page.waitForResponse(r=>r.url().endsWith('/jobs/'+jobId+'/result')&&r.status()===200,{timeout:180000});
 const data=await response.json(),r=data.result;
 if(!['FEASIBLE','OPTIMAL'].includes(r.solverStatus)||r.validation.status!=='VERIFIED'||r.assignments.length!==15500)throw Error('FIXED_NEW_JOB_NOT_VERIFIED');
 const proof=await page.evaluate(async({previous,jobId})=>{
  const u=new URL(location.href),base='/api/companies/'+u.searchParams.get('company'),team=u.searchParams.get('team'),job=await(await fetch(base+'/compute/teams/'+team+'/jobs/'+jobId)).json(),frozen=await(await fetch(base+'/inputs/teams/'+team+'/snapshots/'+job.snapshot_id)).json(),result=await(await fetch(base+'/compute/teams/'+team+'/jobs/'+jobId+'/result')).json();
  const input=frozen.input,a=result.result.assignments.find(a=>a.staffId===previous.lock.staffId&&a.date===previous.lock.date);
  if(frozen.stale||frozen.draftSource?.draftId!==previous.draftId||frozen.draftSource?.draftRevision!==previous.draftRevision||input.staff.length!==500||input.locks.length!==1||input.exceptions.length!==1||JSON.stringify(a.shift)!==JSON.stringify(previous.shift)||input.exceptions[0].reason!==previous.exception.reason||JSON.stringify([...input.locks[0].parts].sort())!=='["break","pattern","time"]'||a.blocks.some(b=>b.start===570))throw Error('FIXED_RECALC_PROOF_MISMATCH');
  const otherUnavailable=input.staff.flatMap(s=>s.unavailable.filter(v=>!(s.id===previous.lock.staffId&&v.date===previous.lock.date)).map(v=>({staffId:s.id,...v})));
  for(const v of otherUnavailable){const day=result.result.assignments.find(a=>a.staffId===v.staffId&&a.date===v.date);if(day?.blocks.some(b=>Math.max(b.start,v.start)<Math.min(b.end,v.end)))throw Error('UNAUTHORIZED_UNAVAILABLE_ASSIGNMENT');}
  return {snapshotId:job.snapshot_id,draftSource:frozen.draftSource,staffCount:input.staff.length,lockCount:input.locks.length,exceptionCount:input.exceptions.length,shift:a.shift,otherUnavailableChecked:otherUnavailable.length,validationStatus:result.result.validation.status};
 },{previous,jobId});
 await page.getByText('対象条件の検証済み',{exact:true}).first().waitFor({timeout:30000});
 return {jobId,elapsedMillis:Date.now()-started,solverStatus:r.solverStatus,validationStatus:r.validation.status,rows:r.assignments.length,objectiveVector:r.validation.objectiveVector,manualReferenceVector:previous.objectiveVector,metrics:r.metrics,proof};
}
