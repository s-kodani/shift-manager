async(page,p,stage)=>{
 if(new URL(page.url()).origin!=='http://localhost:8787')throw Error('LOCAL_ONLY');
 const results=[],check=(name,pass)=>{results.push({name,passed:pass});if(!pass)throw Error('INPUT_SDK_UI_FAILED');};
 if(stage==='bootstrap'){
  await page.context().addCookies(Object.entries(p.cookies).map(([name,value])=>({name,value,url:'http://localhost:8787',httpOnly:true,sameSite:'Lax'})));
  await page.goto('http://localhost:8787/app');
 }
 if(stage==='stale'||stage==='current')await page.reload();
 await page.getByRole('button',{name:'ログアウト',exact:true}).waitFor();
 await page.getByRole('combobox',{name:'企業',exact:true}).selectOption(p.companyId);
 await page.getByRole('combobox',{name:'チーム',exact:true}).selectOption(p.teamId);
 await page.getByLabel('対象月',{exact:true}).fill(p.month);
 const context=await page.evaluate(async()=>{const r=await fetch('/api/context');return {status:r.status,body:await r.json()};});
 check('authenticated_owned_company',context.status===200&&context.body.companies.some(c=>c.id===p.companyId&&c.role==='company_admin'));
 if(stage==='bootstrap')return {stage,companyId:p.companyId,results};
 if(stage==='start-new'){
  const endpoint=`http://localhost:8787/api/companies/${p.companyId}/compute/teams/${p.teamId}/jobs`;
  let captured;
  await page.route(endpoint,async route=>{
   if(route.request().method()!=='POST')return route.continue();
   const c=route.request().postDataJSON();if(c.expectedRevision!==p.currentRevision)throw Error('INPUT_SDK_UI_REVISION');
   // Persist the actual UI operation in the owned timing-control table before
   // Queue acceptance; the private token must never enter CLI output artifacts.
   const arm=await page.request.post('http://localhost:8787/__local/delivery-prepare',{headers:{authorization:'Bearer '+p.pocToken},data:{fixtureId:p.fixtureId,jobId:c.operationId,phase:'after-stop'}});
   if(arm.status()!==200)throw Error('INPUT_SDK_UI_ARM_FAILED');
   captured={jobId:c.operationId,snapshotId:c.snapshotId,revision:c.expectedRevision};await route.continue();
  });
  try{
   const response=page.waitForResponse(r=>r.url()===endpoint&&r.request().method()==='POST');
   await page.getByRole('button',{name:'シフトを計算',exact:true}).click();const r=await response;
   check('normal_ui_accepts_latest_calculation',r.status()===202&&!!captured);
   const body=await r.json();check('accepted_ui_identity_matches_control',body.job.id===captured.jobId);
   return {stage,companyId:p.companyId,results,privateCommand:captured};
  }finally{await page.unroute(endpoint);}
 }
 await page.setViewportSize({width:1280,height:900});
 await page.getByRole('combobox',{name:'計算履歴',exact:true}).selectOption(stage==='stale'?p.oldJobId:p.newJobId);
 const panel=page.getByRole('region',{name:'計算時からの変更',exact:true});
 if(stage==='stale'){await page.locator('.publication-disclosure > summary').click();
  await page.getByRole('button',{name:'計算時からの変更の説明',exact:true}).click();
  await panel.locator('tbody tr').first().waitFor();
  const text=await panel.innerText();
  check('stale_job_has_input_comparison_without_result',text.includes('17:00')&&text.includes('18:00')&&text.includes('16:30'));
  const direct=panel.locator('tbody tr').filter({hasText:'直接入力人数'});
  check('unset_direct_demand_to_zero_is_visible',(await direct.allInnerTexts()).some(t=>t.includes('未入力')&&t.includes('0')));
  check('stale_job_cannot_publish',await page.getByRole('button',{name:'シフトを公開',exact:true}).isDisabled());
 }else{
  check('latest_result_has_no_stale_comparison',await page.getByRole('button',{name:'計算時からの変更の説明',exact:true}).count()===0);
  await page.getByRole('button',{name:'シフトを公開',exact:true}).click();await page.getByRole('button',{name:'再検証して公開',exact:true}).waitFor();
  check('verified_latest_result_exposes_explicit_publish_action',await page.getByRole('button',{name:'再検証して公開',exact:true}).count()===1);
 }
 if(stage==='stale')await panel.scrollIntoViewIfNeeded();await page.screenshot({path:p.artifact+'/'+stage+'.png',fullPage:false});
 return {stage,companyId:p.companyId,results};
}
