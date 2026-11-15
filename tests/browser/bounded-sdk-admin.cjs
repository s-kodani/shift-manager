async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('.candidate-monthly .month-table').waitFor();
 const table=page.locator('.candidate-monthly .month-table').last(),rows=table.locator('tbody tr');
 if(await rows.count()!==500||await table.locator('tbody td').count()!==15500)throw Error('LARGE_MONTH_ROWS_MISMATCH');
 await rows.last().scrollIntoViewIfNeeded();
 const last=rows.last();if(await last.locator('td').count()!==31)throw Error('LAST_MONTH_ROW_MISSING');
 const lastName=await last.locator('th').innerText();const lastDay=table.getByRole('button',{name:'2026-10-31 日別業務配置',exact:true});if(await lastDay.count()!==1)throw Error('LAST_MONTH_DAY_MISSING');
 const staff500=rows.filter({has:page.locator('th').filter({hasText:/^架空スタッフ0500$/})});if(await staff500.count()!==1||await staff500.locator('td').count()!==31)throw Error('STAFF_500_MONTH_MISSING');
 const spacing=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,paddingLeft:parseFloat(getComputedStyle(document.querySelector('main')).paddingLeft),paddingRight:parseFloat(getComputedStyle(document.querySelector('main')).paddingRight)}));
 if(spacing.scrollWidth>1440||spacing.paddingLeft<24||spacing.paddingRight<24)throw Error('ADMIN_UI_SPACING_OR_OVERFLOW');
 await page.screenshot({path:'output/playwright/bounded-sdk/admin-month.png',fullPage:false});
 await lastDay.click();
 const selected=await page.locator('.schedule-detail-dialog').isVisible();if(!selected)throw Error('LAST_DAY_MODAL_FAILED');
 const date=await page.getByRole('textbox',{name:'対象日',exact:true}).inputValue(),dailyPeople=await page.locator('.daily-person').count();if(date!=='2026-10-31'||dailyPeople!==500)throw Error('LAST_DAY_DATA_MISMATCH');
 const replay=await page.evaluate(async()=>{
  const u=new URL(location.href),prefix='/api/companies/'+u.searchParams.get('company')+'/schedules/teams/'+u.searchParams.get('team'),base=prefix+'/publications';
  const head=await(await fetch(base+'?month=2026-10')).json(),id=head.publication.publicationId,p=await(await fetch(base+'/'+id)).json();
  const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationId:id,expectedRevision:p.publication.inputRevision,expectedDraftRevision:p.publication.expectedDraftRevision,expectedPublicationRevision:0,source:p.publication.source,acknowledgeShortage:true})}),data=await r.json();
  if(r.status!==200||data.replayed!==true||data.publicationRevision!==1)throw Error('PUBLICATION_REPLAY_MISMATCH');
  return {status:r.status,replayed:data.replayed,publicationRevision:data.publicationRevision};
 });
 return {rows:500,cells:15500,lastStaffDays:31,lastName,staff500Days:31,lastDayOpened:true,date,dailyPeople,selected,spacing,replay};
}
