async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('heading',{name:'自分の公開済みシフト',exact:true}).waitFor();
 const proof=await page.evaluate(async()=>{
  const u=new URL(location.href),company=u.searchParams.get('company'),team=u.searchParams.get('team'),prefix='/api/companies/'+company;
  const ctx=await(await fetch('/api/context')).json(),identity=ctx.companies.find(c=>c.id===company).teams.find(t=>t.id===team).staff_id;
  const base=prefix+'/schedules/teams/'+team+'/publications',head=await(await fetch(base+'?month=2026-10')).json(),p=head.publication;
  const notices=await(await fetch(base+'/notices')).json(),csv=await fetch(base+'/export?month=2026-10'),jobs=await fetch(prefix+'/compute/teams/'+team+'/jobs'),staff=await fetch(prefix+'/teams/'+team+'/staff');
  if(!identity||head.publicationRevision!==3||p.assignments.length!==31||!p.assignments.every(a=>a.staffId===identity)||p.validation!==undefined||p.exceptions!==undefined||notices.notices.length!==3||notices.notices[0].publicationId!==p.publicationId||[csv.status,jobs.status,staff.status].some(s=>s!==403))throw Error('SELF_SCOPE_OR_NOTICE_MISMATCH');
  const cancelled=p.assignments.find(a=>a.date==='2026-10-02');if(cancelled.shift.workedMinutes!==0||JSON.stringify(cancelled.shift.cancelled)!=='[[540,720]]'||cancelled.blocks.length)throw Error('SELF_CANCELLED_WORK_REINTRODUCED');return {targetShift:cancelled.shift,publicationId:p.publicationId,staffId:identity,days:p.assignments.length,notices:notices.notices.length,publicationRevision:head.publicationRevision,csvStatus:csv.status,jobsStatus:jobs.status,staffListStatus:staff.status};
 });
 if(await page.locator('.published-day').count()!==31||await page.locator('.candidate-monthly .month-table').count()!==0)throw Error('SELF_UI_ROWS_MISMATCH');
 const spacing=await page.evaluate(()=>{const main=document.querySelector('main'),panel=[...document.querySelectorAll('section')].find(s=>s.querySelector('h2')?.textContent==='自分の公開済みシフト'),r=panel.getBoundingClientRect();return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,paddingLeft:parseFloat(getComputedStyle(main).paddingLeft),paddingRight:parseFloat(getComputedStyle(main).paddingRight),panelLeft:r.left,panelRight:r.right};});
 if(spacing.scrollWidth>390||spacing.paddingLeft<16||spacing.paddingRight<16||spacing.panelLeft<16||spacing.panelRight>374)throw Error('SELF_UI_SPACING_OR_OVERFLOW');
 await page.getByRole('button',{name:'既読にする',exact:true}).first().click();
 await page.getByText('既読',{exact:true}).waitFor();
 await page.getByRole('button',{name:'対象の公開版を見る',exact:true}).first().click();
 await page.getByRole('heading',{name:'自分の公開済みシフト',exact:true}).waitFor();
 await page.locator('.published-day').last().waitFor();
 if(await page.locator('.published-day').count()!==31)throw Error('SELF_NOTICE_TARGET_ROWS_MISMATCH');
 await page.getByRole('heading',{name:'自分の公開済みシフト',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:'output/playwright/bounded-sdk/staff-cancelled-mobile.png',fullPage:false});
 return {proof,spacing,visibleCards:31,noticeOpened:true,noticeRead:true};
}
