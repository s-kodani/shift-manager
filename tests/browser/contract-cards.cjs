async(page)=>{
 const base='http://127.0.0.1:8797',output='output/playwright/contract-cards',results=[],errors=[],writes=[],unknown=[];
 const check=(v,c)=>{if(!v)throw Error(c);};const b=name=>page.getByRole('button',{name,exact:true});
 const common=()=>page.getByRole('region',{name:'企業共通ルール・雇用区分',exact:true}),personal=()=>page.getByRole('region',{name:'勤務契約とスキル',exact:true});
 const employment='77777777-7777-4777-8777-777777777777',first='33333333-3333-4333-8333-333333333331',second='33333333-3333-4333-8333-333333333332';
 const rule={dailyMax:480,weeklyMax:2400,monthlyMin:0,monthlyMax:9600,minDays:0,minOff:0,maxConsecutive:31},contract={weekdays:[0,1,2,3,4,5,6],start:480,end:1200};
 const policy={rule,contract,skillLevels:[{level:0,name:'初級'},{level:1,name:'標準'}],breakRule:{basis:'elapsed',threshold:360,requiredMinutes:60,afterStart:120,beforeEnd:60}};
 let release;const gate=new Promise(r=>{release=r;});let delay=true,fail=false;
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('**/api/**',async route=>{
  const r=route.request(),u=new URL(r.url());check(u.origin===base,'LOCAL_ONLY');
  if(r.method()!=='GET'){writes.push(u.pathname);await route.abort();return;}
  if(delay)await gate;
  let body,status=200;
  if(u.pathname.includes('/contract-options/')){body={revision:1,policy,employment:[{id:employment,version:employment,effectiveFrom:'2026-10',revision:1,payload:{name:'架空雇用区分',rule,contract}}]};if(fail){body={error:'INTERNAL_ERROR'};status=500;}}
  else if(u.pathname.includes('/contract/'))body={version:{id:'test-profile',effectiveFrom:'2026-10',revision:1,payload:{employmentTypeId:employment,contract,rule:null,skills:[{taskId:'phone',level:1}],roleIds:[]}}};
  else{unknown.push(u.pathname);body={};}
  await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
 });
 const ready=async()=>{await b('勤務契約・習熟度・対応可能な担当をすべて保存').waitFor();await page.waitForFunction(()=>document.querySelectorAll('[data-slot=loading]').length===0);};
 const saved=async n=>{await page.waitForFunction(n=>JSON.parse(document.querySelector('#saved').textContent).length===n,n);await ready();return JSON.parse(await page.locator('#saved').innerText());};
 await page.goto(base);
 await page.getByText('企業共通ルール・雇用区分を取得しています…',{exact:true}).waitFor();await page.getByText('契約条件を取得しています…',{exact:true}).waitFor();
 delay=false;release();await ready();
 check(await common().getByRole('heading',{name:'企業共通ルール（参照）',exact:true}).count()===1,'COMMON_REFERENCE_MISSING');
 check(await common().getByText('雇用区分を追加',{exact:true}).count()===1,'EMPLOYMENT_ADD_OUTSIDE_COMMON');
 check(await common().getByRole('combobox',{name:'契約を編集するスタッフ',exact:true}).count()===0,'STAFF_SELECTOR_IN_COMMON');
 check(await personal().getByRole('combobox',{name:'契約を編集するスタッフ',exact:true}).count()===1,'STAFF_SELECTOR_MISSING');
 check(await personal().getByText('雇用区分を追加',{exact:true}).count()===0,'EMPLOYMENT_ADD_IN_PERSONAL');
 check(await personal().getByRole('heading',{name:'企業共通ルール（参照）',exact:true}).count()===0,'COMMON_REFERENCE_IN_PERSONAL');
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:width===1280?2000:900});const layout=await page.evaluate(()=>{const cards=[...document.querySelectorAll('section[data-slot=card]')];return {viewport:innerWidth,width:document.documentElement.scrollWidth,gap:cards[1].getBoundingClientRect().top-cards[0].getBoundingClientRect().bottom};});
  check(layout.width<=width&&layout.gap>=24,'CARD_LAYOUT');await page.screenshot({path:output+'/cards-'+width+'.png',fullPage:width!==1280});results.push(layout);
 }
 const existing=()=>common().locator('form').filter({has:page.getByRole('button',{name:'この雇用区分を対象月から保存',exact:true})});
 await common().locator('summary').filter({hasText:'架空雇用区分'}).click();await existing().getByRole('textbox',{name:'雇用区分名',exact:true}).fill('未保存の共通条件');
 await personal().getByRole('combobox',{name:'契約を編集するスタッフ',exact:true}).selectOption(second);await page.getByRole('alertdialog').waitFor();await b('編集を続ける').click();
 check(await existing().getByRole('textbox',{name:'雇用区分名',exact:true}).inputValue()==='未保存の共通条件','CANCEL_LOST_COMMON_EDIT');
 check(await personal().getByRole('combobox',{name:'契約を編集するスタッフ',exact:true}).inputValue()===first,'CANCEL_CHANGED_STAFF');
 await personal().getByRole('combobox',{name:'契約を編集するスタッフ',exact:true}).selectOption(second);await page.getByRole('alertdialog').waitFor();await b('変更を破棄して進む').click();await ready();
 await common().locator('summary').filter({hasText:'架空雇用区分'}).click();await existing().getByRole('textbox',{name:'雇用区分名',exact:true}).fill(' ');await b('この雇用区分を対象月から保存').click();await common().getByRole('alert').waitFor();check(await personal().getByRole('alert').count()===0,'ERROR_IN_WRONG_CARD');check(JSON.parse(await page.locator('#saved').innerText()).length===0,'INVALID_EMPLOYMENT_SAVED');await existing().getByRole('textbox',{name:'雇用区分名',exact:true}).fill('更新した雇用区分');await b('この雇用区分を対象月から保存').click();let records=await saved(1);
 check(records[0].path.endsWith('/employment/'+employment)&&records[0].payload.name==='更新した雇用区分','COMMON_EDIT_PAYLOAD');
 await common().getByText('雇用区分を追加',{exact:true}).click();const fresh=common().locator('form').filter({has:page.getByRole('button',{name:'雇用区分を登録',exact:true})});await fresh.getByRole('textbox',{name:'雇用区分名',exact:true}).fill('追加した雇用区分');await b('雇用区分を登録').click();records=await saved(2);
 check(records[1].path.includes('/inputs/employment/')&&records[1].payload.name==='追加した雇用区分','COMMON_ADD_PAYLOAD');
 const profile=personal().locator('form');await profile.getByRole('combobox',{name:'勤務可能な開始時刻',exact:true}).selectOption('');await b('勤務契約・習熟度・対応可能な担当をすべて保存').click();check(JSON.parse(await page.locator('#saved').innerText()).length===2,'INCOMPLETE_PROFILE_SAVED');await profile.getByRole('combobox',{name:'勤務可能な開始時刻',exact:true}).selectOption('480');for(const day of ['日','月','火','水','木','金','土'])await profile.getByRole('checkbox',{name:day,exact:true}).uncheck();await profile.getByRole('checkbox',{name:'月',exact:true}).check();await profile.getByRole('combobox',{name:'電話（最低習熟度 1）',exact:true}).selectOption('0');await profile.getByRole('checkbox',{name:'リーダー',exact:true}).check();await b('勤務契約・習熟度・対応可能な担当をすべて保存').click();records=await saved(3);
 check(records[2].path.endsWith('/staff/'+second+'/contract')&&records[2].payload.skills[0].level===0&&records[2].payload.roleIds[0]==='leader'&&records[2].payload.contract.weekdays.join()==='1','PROFILE_FORMDATA');
 check(Number(await page.locator('#changes').innerText())>0,'EDIT_SIGNAL_LOST');results.push({commonAndPersonalSeparated:true,unsavedCancelAndAccept:true,employmentEditAndAdd:true,profilePayload:true,errorScopedToCard:true});
 await page.goto(base+'/?role=team');await ready();check(await common().locator('form').count()===0&&await common().getByText('雇用区分を追加',{exact:true}).count()===0,'TEAM_ADMIN_COMMON_WRITE');check(await personal().locator('form').count()===1,'TEAM_ADMIN_PERSONAL_MISSING');
 await page.goto(base+'/?empty=1');await common().getByText('雇用区分を追加',{exact:true}).waitFor();await personal().getByText('スタッフを登録すると、個別の勤務契約・習熟度・対応可能な担当を設定できます。',{exact:true}).waitFor();check(await personal().getByRole('combobox',{name:'契約を編集するスタッフ',exact:true}).isDisabled(),'EMPTY_SELECTOR_ENABLED');
 fail=true;await page.goto(base);await page.getByText('契約条件を取得できませんでした。最新の入力を読み直してください。',{exact:true}).waitFor();check(await common().getByRole('alert').count()===1&&await personal().getByRole('alert').count()===1&&await page.locator('[data-slot=loading]').count()===0,'ERROR_LOAD_STATE');
 results.push({teamAdminReadOnlyCommon:true,emptyStaffCommonUsable:true,loadingAndErrorStates:true});check(errors.length===0&&writes.length===0&&unknown.length===0,'UNEXPECTED_ERRORS_OR_WRITES');
 return {results,errors,writes,unknown,capturedSaveCallbacks:3,backendWrites:0,cloudflareRequests:0};
}
