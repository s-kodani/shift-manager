async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 const started=Date.now();
 const acceptedResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/jobs')&&r.status()===202,{timeout:30000});
 await page.getByRole('button',{name:'シフトを計算',exact:true}).click();
 const accepted=await(await acceptedResponse).json(),jobId=accepted.job.id;
 const response=await page.waitForResponse(r=>r.url().endsWith('/jobs/'+jobId+'/result')&&r.status()===200,{timeout:180000});
 const data=await response.json(),r=data.result;
 if(!['FEASIBLE','OPTIMAL'].includes(r.solverStatus)||r.validation.status!=='VERIFIED'||r.assignments.length!==15500)throw Error('LARGE_NEW_JOB_NOT_VERIFIED');
 await page.getByText('対象条件の検証済み',{exact:true}).first().waitFor({timeout:30000});
 return {jobId,elapsedMillis:Date.now()-started,solverStatus:r.solverStatus,validationStatus:r.validation.status,rows:r.assignments.length,objectiveVector:r.validation.objectiveVector,metrics:r.metrics};
}
