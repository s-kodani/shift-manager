async(page,owner)=>{
 const check=(value,code)=>{if(!value)throw Error(code);};
 const button=name=>page.getByRole('button',{name,exact:true});
 const results=[],screenshots=[];let step='init';try{
 if(owner.stage==='settings'){
  await page.unrouteAll();await page.goto('http://localhost:8787/app?month=2026-10&section=readiness');await page.locator('.readiness-panel').waitFor();
  await page.locator('.readiness-panel').getByText(/^(計算を開始できます。|警告が1件あります。内容を確認のうえ計算できます。)$/).waitFor();
  await button('スタッフ管理').click();await button('勤務契約・習熟度・対応可能な担当をすべて保存').waitFor();
  await page.getByRole('textbox',{name:'氏名',exact:true}).fill('未保存の架空入力');await button('シフト計算の準備').click();await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:'編集を続ける',exact:true}).click();check(await page.getByRole('heading',{name:'スタッフ管理',exact:true}).count()===1,'UNSAVED_CANCEL_NAVIGATED');
  await button('シフト計算の準備').click();await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:'変更を破棄して進む',exact:true}).click();await page.locator('.readiness-panel').getByText(/^(計算を開始できます。|警告が1件あります。内容を確認のうえ計算できます。)$/).waitFor();
  await button('スタッフ管理').click();await button('勤務契約・習熟度・対応可能な担当をすべて保存').waitFor();await page.waitForTimeout(200);
  const saved=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/contract')&&r.status()===200);await button('勤務契約・習熟度・対応可能な担当をすべて保存').click();await saved;await page.waitForTimeout(200);await button('シフト計算の準備').click();await page.locator('.readiness-panel').getByText(/^(計算を開始できます。|警告が1件あります。内容を確認のうえ計算できます。)$/).waitFor();
  return {stage:owner.stage,passed:true,unsavedCancel:true,unsavedDiscard:true,settingSaveAndRecheck:true,solverStarts:0};
 }
 if(owner.stage==='toast'){
  await page.goto('http://127.0.0.1:8795/');await page.getByRole('heading',{name:'Toast verification'}).waitFor();
  await page.clock.install();
  const toast=()=>page.locator('.toast-item');
  for(const kind of ['success','info','warning','error']){
   await button(kind).click();await toast().waitFor();await page.mouse.move(1,1);
   await page.clock.fastForward(4500);check(await toast().count()===1,'TOAST_EARLY_'+kind);
   await page.clock.fastForward(650);await toast().waitFor({state:'hidden'});
   check(await page.getByRole('alert').textContent()==='Persistent inline error','INLINE_ERROR_LOST');
   results.push({kind,duration:5000,passed:true});
  }
  await button('warning').click();await toast().waitFor();await page.clock.fastForward(1000);await toast().hover();await page.clock.fastForward(6000);check(await toast().count()===1,'HOVER_NOT_PAUSED');await page.mouse.move(1,1);await page.clock.fastForward(4200);await toast().waitFor({state:'hidden'});
  await button('error').click();await toast().waitFor();await page.clock.fastForward(1000);await button('通知を閉じる').focus();await page.clock.fastForward(6000);check(await toast().count()===1,'FOCUS_NOT_PAUSED');await button('success').focus();await page.clock.fastForward(4200);await toast().waitFor({state:'hidden'});
  await button('info').click();await toast().waitFor();await button('通知を閉じる').click();await toast().waitFor({state:'hidden'});
  await button('success').click();await toast().waitFor();await page.clock.fastForward(30);const box=await toast().boundingBox();await page.mouse.move(box.x+50,box.y+20);await page.mouse.down();await page.mouse.move(box.x+box.width+100,box.y+20,{steps:12});await page.mouse.up();await page.clock.fastForward(500);await toast().waitFor({state:'hidden'});
  return {stage:owner.stage,passed:true,results,hoverPause:true,focusPause:true,manualClose:true,swipe:true,persistentInlineError:true};
 }
 await page.unrouteAll({behavior:'wait'});await page.goto('http://localhost:8787/app?month=2026-10&section=readiness');await page.locator('.readiness-panel').waitFor();
 const card=()=>page.locator('.readiness-panel');
 await card().getByText(/^(計算を開始できます。|警告が1件あります。内容を確認のうえ計算できます。)$/).waitFor();
 const real=await page.evaluate(async()=>{const c=document.querySelector('[aria-label="企業"]').value,t=document.querySelector('[aria-label="チーム"]').value,m=document.querySelector('[aria-label="対象月"]').value;return await(await fetch(`/api/companies/${c}/inputs/teams/${t}/readiness/${m}`)).json();});
 check(real.canCompute===true&&real.items.find(i=>i.id==='history').status==='missing','REAL_READINESS');
 check(await card().evaluate(el=>el.previousElementSibling.classList.contains('page-head')),'CARD_ORDER');
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));
  const rect=await card().evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,document:document.documentElement.scrollWidth};});
  check(rect.left>=0&&rect.right<=width&&rect.document<=width,'OVERFLOW_'+width);
  check(await card().locator('.readiness-item').count()===9,'CHECK_ITEMS_MISSING');
  check(await card().locator('details').count()===0,'CHECK_ITEMS_COLLAPSED');
  const file=owner.output+'/readiness-'+width+'.png';await page.screenshot({path:file,fullPage:false});screenshots.push(file);results.push({width,...rect});
 }
 let mode='ready',calls=0,heldResolve,heldArrived;
 let holdSeen=new Promise(resolve=>heldArrived=resolve);
 const writes=[];
 await page.route('**/api/**',async route=>{
  if(route.request().method()!=='GET'){writes.push(new URL(route.request().url()).pathname);await route.abort();return;}
  if(!route.request().url().includes('/readiness/')){if(/\/(config|planning)\//.test(route.request().url())){const response=await route.fetch({url:route.request().url().replace(/20\d{2}-\d{2}$/,real.month)});await route.fulfill({response});}else await route.continue();return;}
  calls++;const captured=mode;const month=new URL(route.request().url()).pathname.split('/').pop();
  if(captured==='hold'){heldArrived();await new Promise(resolve=>heldResolve=resolve);}
  if(captured==='failure'){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'SERVICE_UNAVAILABLE'})});return;}
  const data=structuredClone(real);data.month=month;
  if(captured==='stale')data.inputRevision++;
  if(['missing','hold'].includes(captured)){const i=data.items.find(i=>i.id==='contracts');i.status='missing';i.message='1名の個人契約が未登録です。';i.count=1;data.canCompute=false;}
  if(captured==='invalid'){const i=data.items.find(i=>i.id==='consistency');i.status='invalid';i.message='登録した勤務条件が矛盾しています。';i.code='CONTRADICTORY_CONTRACT';data.canCompute=false;}
  if(captured==='ready'){const i=data.items.find(i=>i.id==='planning');i.status='warning';i.code='DEMAND_COVERAGE_MISSING';i.count=0;i.demandCoverage={expectedSlots:1,missingSlots:1,examples:[{date:month+'-01',start:540,end:570,taskId:'phone'}]};i.message='企業共通の勤務可能曜日・時間帯に未登録の需要があります。計算は可能です。';}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
 });
 const refresh=async()=>{await button('最新の条件で再確認').click();};
 step='missing';mode='missing';await refresh();await card().getByText('1名の個人契約が未登録です。',{exact:true}).waitFor();
 step='navigation';await card().getByRole('button',{name:'個人契約・雇用区分の設定を確認',exact:true}).click();await page.getByRole('heading',{name:'スタッフ一覧',exact:true}).waitFor();
 step='return';await page.waitForTimeout(200);await button('シフト計算の準備').click();await card().getByText('1名の個人契約が未登録です。',{exact:true}).waitFor();
 step='invalid';mode='invalid';await refresh();await card().getByText('登録した勤務条件が矛盾しています。',{exact:true}).waitFor();
 step='failure';mode='failure';await refresh();await card().getByText('準備状況を確認できませんでした。最新の条件を読み直して再確認してください。',{exact:true}).waitFor();
 await page.mouse.move(1,1);await page.waitForTimeout(5300);check(await page.locator('.toast-item').count()===0,'ERROR_TOAST_REMAINS');check(await card().getByRole('alert').count()===1,'PERSISTENT_READINESS_ERROR_LOST');
 step='stale';mode='stale';await refresh();await card().getByText('入力または編集の版が変わっています。最新の条件を読み直して再確認してください。',{exact:true}).waitFor();
 step='hold';mode='hold';await refresh();await holdSeen;
 step='switch';mode='ready';const month=page.locator('input[type="month"]');const next=real.month==='2026-11'?'2026-12':'2026-11';await month.fill(next);await month.press('Tab');await card().getByText(/^(計算を開始できます。|警告が1件あります。内容を確認のうえ計算できます。)$/).waitFor();heldResolve();await page.waitForTimeout(250);
 await card().getByText('企業共通の勤務可能曜日・時間帯に未登録の需要があります。計算は可能です。',{exact:true}).waitFor();
 const beforeFocus=calls;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.waitForTimeout(250);check(calls>beforeFocus,'FOCUS_NOT_REFRESHED');
 check(writes.length===0,'COMPUTE_OR_WRITE_STARTED');
 return {stage:owner.stage,passed:true,realApi:true,results,screenshots,checks:['history and missing wishes nonblocking','all nine items expanded','missing/invalid/loading/failure/stale messages','navigation and return refresh','old month response discarded','focus refresh','empty demand nonblocking','persistent error after toast expires'],requests:calls,writes};
}catch(error){throw Error('READINESS_STEP_'+step+' '+error.message);}
}
