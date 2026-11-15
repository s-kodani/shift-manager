async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 await page.getByRole('button',{name:'シフト・計算結果',exact:true}).click();
 const before=await page.evaluate(async()=>{
  const u=new URL(location.href),base='/api/companies/'+u.searchParams.get('company')+'/schedules/teams/'+u.searchParams.get('team'),head=await(await fetch(base+'/publications?month=2026-10')).json();
  if(head.publicationRevision!==2||head.publication.assignments.length!==15500)throw Error('EXPECTED_CANCELLED_PUBLICATION_TWO');
  return {publicationId:head.publication.publicationId,rows:head.publication.assignments.map(a=>({staffId:a.staffId,date:a.date,shift:a.shift}))};
 });
 const started=Date.now(),acceptedResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/jobs')&&r.status()===202,{timeout:30000});
 await page.getByRole('button',{name:'シフトを計算',exact:true}).click();
 const accepted=await(await acceptedResponse).json(),jobId=accepted.job.id;
 const response=await page.waitForResponse(r=>r.url().endsWith('/jobs/'+jobId+'/result')&&r.status()===200,{timeout:180000});
 const data=await response.json(),r=data.result;
 if(!['FEASIBLE','OPTIMAL'].includes(r.solverStatus)||r.validation.status!=='VERIFIED'||r.assignments.length!==15500)throw Error('REALLOCATION_NEW_JOB_NOT_VERIFIED');
 const proof=await page.evaluate(async({before,jobId})=>{
  const u=new URL(location.href),base='/api/companies/'+u.searchParams.get('company'),team=u.searchParams.get('team'),job=await(await fetch(base+'/compute/teams/'+team+'/jobs/'+jobId)).json(),frozen=await(await fetch(base+'/inputs/teams/'+team+'/snapshots/'+job.snapshot_id)).json(),saved=await(await fetch(base+'/compute/teams/'+team+'/jobs/'+jobId+'/result')).json();
  if(frozen.stale||frozen.input.staff.length!==500||frozen.input.published.length!==15500)throw Error('REALLOCATION_SOURCE_MISMATCH');
  const key=a=>a.staffId+'|'+a.date,old=new Map(before.rows.map(a=>[key(a),a.shift]));let cancelledDays=0;
  for(const row of saved.result.assignments){if(!old.has(key(row))||JSON.stringify(row.shift)!==JSON.stringify(old.get(key(row))))throw Error('PUBLISHED_TIME_REST_CANCELLATION_CHANGED');if(row.shift?.cancelled.length){cancelledDays++;for(const interval of row.shift.cancelled)if(row.blocks.some(b=>Math.max(b.start,interval[0])<Math.min(b.end,interval[1])))throw Error('CANCELLED_WORK_REINTRODUCED');}}
  const head=await(await fetch(base+'/schedules/teams/'+team+'/publications?month=2026-10')).json();if(head.publicationRevision!==2||head.publication.publicationId!==before.publicationId||cancelledDays!==1)throw Error('REALLOCATION_AUTO_PUBLISHED');
  return {snapshotId:job.snapshot_id,publishedRows:frozen.input.published.length,shiftRowsCompared:saved.result.assignments.length,cancelledDays,publicationRevisionBeforeSeparatePublish:head.publicationRevision,allShiftFieldsPreserved:true};
 },{before,jobId});
 await page.getByText('対象条件の検証済み',{exact:true}).first().waitFor({timeout:30000});
 return {jobId,elapsedMillis:Date.now()-started,solverStatus:r.solverStatus,validationStatus:r.validation.status,rows:r.assignments.length,objectiveVector:r.validation.objectiveVector,metrics:r.metrics,proof};
}
