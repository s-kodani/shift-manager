async(page)=>{
 const base='http://127.0.0.1:8796',output='output/playwright/time-input',results=[],posts=[],errors=[],unknown=[];
 const check=(v,c)=>{if(!v)throw Error(c);};const f=name=>page.getByRole('textbox',{name,exact:true}),b=name=>page.getByRole('button',{name,exact:true});
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 const uuid='33333333-3333-4333-8333-333333333333';
 const deadline={month:'2026-10',configuredDay:20,deadlineDate:'2026-09-20',timeZone:'Asia/Tokyo',closesAt:1};
 let own=null,window=null;
 await page.route('**/api/**',async route=>{
  check(new URL(route.request().url()).origin===base,'LOCAL_ONLY');
  const p=new URL(route.request().url()).pathname;let body;
  if(route.request().method()==='POST'){
   const data=route.request().postDataJSON();posts.push({path:p,body:data});
   if(p.includes('/self-month/'))own={id:uuid,revision:1,payload:data.payload};
   else if(p.includes('/submission-window/'))window={id:uuid,revision:1,closesAt:data.closesAt};
   else unknown.push(p);
   body={id:uuid,revision:1,replayed:false};
  }else if(p.includes('/contract-options/'))body={revision:0,roleRounding:'ceil'};
  else if(p.includes('/self-month/'))body={month:'2026-10',revision:0,staffId:uuid,calendarId:uuid,serverTime:1,deadline,window,accepting:true,version:own,patterns:[]};
  else if(p.includes('/submission-window/'))body={month:'2026-10',serverTime:1,deadline,window};
  else{unknown.push(p);body={error:'INTERNAL_ERROR'};}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(base+'/?view=planning');await b('すべての需要・予定・担当区分を保存').waitFor();
 check(await f('需要 1 開始').inputValue()==='1000','LOADED_DEMAND_FORMAT');
 await page.getByRole('tab',{name:'研修・会議',exact:true}).click();
 check(await f('予定 1 開始').inputValue()==='1007','LOADED_MINUTE_FORMAT');
 await page.getByRole('tab',{name:'必要人数',exact:true}).click();
 for(const value of ['093','0960']){await f('需要 1 開始').fill(value);await b('すべての需要・予定・担当区分を保存').click();check(await page.locator('#saved').innerText()==='[]','INVALID_PLANNING_SAVED');check(!await f('需要 1 開始').evaluate(e=>e.validity.valid),'INVALID_TIME_VALID');}
 await f('需要 1 開始').fill('0930');await f('需要 1 開始').fill('09:30');check(await f('需要 1 開始').inputValue()==='0930','COLON_ACCEPTED');
 await f('需要 1 終了').fill('1000');await page.getByRole('tab',{name:'研修・会議',exact:true}).click();await f('予定 1 開始').fill('2357');await f('予定 1 終了').fill('2400');
 await b('すべての需要・予定・担当区分を保存').click();await page.waitForFunction(()=>JSON.parse(document.querySelector('#saved').textContent).length===1);
 const planned=JSON.parse(await page.locator('#saved').innerText())[0];check(planned.demand[0].start===570&&planned.demand[0].end===600&&planned.events[0].start===1437&&planned.events[0].end===1440,'PLANNING_MINUTES');
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'PLANNING_OVERFLOW');await page.screenshot({path:output+'/planning-'+width+'.png',fullPage:true});}
 results.push({name:'planning loaded HHMM, invalid submission blocked, midnight and exact minutes',passed:true,payload:planned});
 await page.goto(base+'/?view=staff');await b('勤務不可を追加').waitFor();await b('勤務不可を追加').click();
 await f('開始（HHMM）').fill('1007');await f('終了（HHMM、2400可）').fill('1017');await b('すべての勤務不可・希望を保存').click();
 await page.getByText('設定を保存しました。再計算で最新条件に反映されます。',{exact:true}).waitFor();
 check(posts.length===1&&posts[0].body.payload.unavailable[0].start===607&&posts[0].body.payload.unavailable[0].end===617,'SUBMISSION_MINUTES');
 await page.getByLabel('追加受付の終了日（日本時間）',{exact:true}).fill('2026-10-31');await f('追加受付の終了時刻（HHMM・日本時間）').fill('2400');await b('この日時まで受付を再開').click();check(posts.length===1,'WINDOW_ACCEPTED_2400');
 await f('追加受付の終了時刻（HHMM・日本時間）').fill('2359');await b('この日時まで受付を再開').click();await f('追加受付の終了時刻（HHMM・日本時間）').waitFor();
 await page.getByText('指定日時まで受付を再開しました。',{exact:true}).waitFor();
 check(posts.length===2&&posts[1].body.closesAt===Date.parse('2026-10-31T23:59:00+09:00'),'JST_CHANGED');
 for(const width of [390,320]){await page.setViewportSize({width,height:900});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'STAFF_OVERFLOW');await page.screenshot({path:output+'/staff-'+width+'.png',fullPage:true});}
 results.push({name:'self-minute precision, numeric deadline time, preserved JST and 2359 bound',passed:true});
 await page.goto(base+'/?view=draft');await page.locator('.draft-editor > details > summary').click();await f('休憩開始').waitFor();check(await f('休憩開始').inputValue()==='0930','BREAK_FORMAT');
 const start=f('担当区分の区間1の開始');await start.fill('');
 for(const digit of ['0','9','3']){await start.pressSequentially(digit);await b('検証して編集案を保存').click();check(await page.locator('#saved').innerText()==='[]','PARTIAL_DRAFT_SAVED');}
 check(await start.inputValue()==='093','PARTIAL_TEXT_LOST');await start.pressSequentially('0');check(await start.inputValue()==='0930','LEADING_ZERO_LOST');
 await f('休憩開始').fill('0917');await b('検証して編集案を保存').click();check(await page.locator('#saved').innerText()==='[]','BREAK_ALIGNMENT_LOST');
 await f('休憩開始').fill('1000');await f('休憩終了').fill('1030');await start.fill('1007');await f('担当区分の区間1の終了').fill('1017');
 await f('例外の開始').fill('1007');await f('例外の終了').fill('1017');await b('検証して編集案を保存').click();await page.waitForFunction(()=>JSON.parse(document.querySelector('#saved').textContent).length===1);
 const draft=JSON.parse(await page.locator('#saved').innerText())[0];check(JSON.stringify(draft.assignments[0].shift.break)==='[600,630]'&&draft.assignments[0].roleIntervals[0].start===607&&draft.exceptions[0].start===607,'DRAFT_MINUTES');
 await start.fill('0');await page.getByRole('combobox',{name:'編集する日',exact:true}).selectOption('2026-10-02');check(await start.inputValue()==='1007','OTHER_DATE_RETAINED_PARTIAL');
 for(const width of [1280,390,320]){await page.setViewportSize({width,height:900});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'DRAFT_OVERFLOW');await page.screenshot({path:output+'/draft-'+width+'.png',fullPage:true});}
 results.push({name:'manual edit partial digits retained, invalid save blocked, half-hour break and minute roles/exceptions, date scope reset',passed:true});
 check(errors.length===0,'PAGE_ERRORS');check(unknown.length===0,'UNKNOWN_API');return {results,errors,unknown,simulatedPosts:posts.length,backendWrites:0,cloudflareRequests:0};
}
