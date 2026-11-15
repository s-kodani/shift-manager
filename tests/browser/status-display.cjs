async(page,fixture)=>{
 const assert=(value,code)=>{if(!value)throw Error(code);};
 assert(new URL(page.url()).origin==='http://127.0.0.1:8894','LOCAL_ONLY');
 const jobs=`/api/companies/${fixture.company}/compute/teams/${fixture.team}/jobs`;
 let selected=fixture.statusCases[0],jobLists=0;
 await page.unroute('**/api/**');
 await page.route('**/api/**',async route=>{
   if(new URL(route.request().url()).pathname===jobs){jobLists++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({jobs:[selected.job]})});}
   else await route.continue();
 });
 const results=[];
 for(const name of ['feasible','unknown','failed','running']){
   selected=fixture.statusCases.find(c=>c.name===name);assert(selected,'MISSING_CASE');
   await page.setViewportSize({width:name==='unknown'||name==='failed'?390:1280,height:900});
   await page.reload();
   const history=page.getByRole('combobox',{name:'計算履歴',exact:true});
   await page.waitForFunction(id=>document.querySelector('[aria-label="計算履歴"]')?.value===id,selected.job.id);
   if(name==='feasible'){
     await page.getByText('有効案あり・最良値は未証明',{exact:true}).waitFor();
     assert(await page.getByRole('button',{name:'再検証して公開',exact:true}).isDisabled(),'REFERENCE_PUBLISH_ENABLED');
   }else if(name==='unknown'){
     await page.getByText('探索内で案を発見できませんでした',{exact:true}).waitFor();
     assert(await page.getByText('解なしを証明',{exact:true}).count()===0,'UNKNOWN_IS_INFEASIBLE');
     assert(await page.getByText('検証未実行',{exact:true}).count()>0,'UNKNOWN_CHECK_STATE');
     assert(await page.getByRole('button',{name:'再検証して公開',exact:true}).isDisabled(),'UNKNOWN_PUBLISH_ENABLED');
   }else if(name==='failed'){
     await page.getByText('処理の失敗が記録されています。',{exact:false}).waitFor();
     assert(await page.getByRole('button',{name:'再検証して公開',exact:true}).count()===0,'FAILURE_PUBLISH_VISIBLE');
   }else{
     await page.getByText('計算・独立検証の完了を待っています。',{exact:true}).waitFor();
     assert(await page.getByRole('button',{name:'計算を取り消す',exact:true}).isEnabled(),'RUNNING_CANCEL_UNAVAILABLE');
     assert(await page.getByRole('button',{name:'シフトを計算',exact:true}).isDisabled(),'RUNNING_SECOND_COMPUTE_ENABLED');
     assert(await page.getByRole('button',{name:'再検証して公開',exact:true}).count()===0,'RUNNING_PUBLISH_VISIBLE');
   }
   if(name!=='running')assert(await page.getByRole('button',{name:'シフトを計算',exact:true}).isEnabled(),'TERMINAL_RECALCULATE_UNAVAILABLE');
   assert(await page.getByText('有効案あり・最良値は未証明',{exact:true}).count()===(name==='feasible'?1:0),'OLD_RESULT_REMAINS');
   const layout=await page.evaluate(()=>({width:innerWidth,pageWidth:document.documentElement.scrollWidth}));assert(layout.pageWidth<=layout.width,'PAGE_OVERFLOW');
   await page.getByText(name==='feasible'?'有効案あり・最良値は未証明':name==='unknown'?'探索内で案を発見できませんでした':name==='failed'?'処理の失敗が記録されています。':'計算・独立検証の完了を待っています。',{exact:name!=='failed'}).scrollIntoViewIfNeeded();
   await page.screenshot({path:fixture.artifact+'/status-'+name+'.png'});
   results.push({name,jobId:selected.job.id,passed:true,...layout});
 }
 await page.goto('about:blank'); // end the running-state read poll before inspection
 const response=await page.request.get('http://127.0.0.1:8894/__display/status');
 const status=await response.json();assert(status.writeRequests===0,'WRITE_DISPATCHED');
 return {results,jobLists,writeRequests:0,scope:'real built UI; controlled GET/auth/job states; no real backend, solve, retry, cancellation or publication'};
}
