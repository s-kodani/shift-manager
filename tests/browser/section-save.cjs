async (page, owner) => {
  const {base, id, input, output}=owner, check=(value,code)=>{if(!value)throw Error(code);};
  const results=[], calls=[], errors=[], unknown=[], screenshots=[], csvAttempts=[];
  let revision=1, fail='', step='init', requests=0, secondProfile=null, externalRefresh=false;
  const rule={dailyMax:480,weeklyMax:2400,monthlyMin:60,monthlyMax:12000,minDays:1,minOff:4,maxConsecutive:6};
  let policy={rule,contract:{weekdays:[0,1,2,3,4,5,6],start:480,end:1200},skillLevels:[{level:1,name:'標準'},{level:2,name:'熟練'}],breakRule:{basis:'elapsed',threshold:360,requiredMinutes:60,afterStart:120,beforeEnd:60}};
  let config={slotMinutes:30,priority:'coverage',capacityScale:100,patterns:[{id:'day',start:540,end:1020,breakKind:'auto'}],tasks:input.tasks.map(t=>({...t,minimumMinutes:10,capacities:[{level:1,capacity:100},{level:2,capacity:150}]})),roles:input.roles,transitions:input.tasks.flatMap(a=>input.tasks.filter(b=>a.id!==b.id).map(b=>({fromTaskId:a.id,toTaskId:b.id,minutes:0}))),rolePolicies:[{taskId:null,priority:'first'},...input.tasks.map(t=>({taskId:t.id,priority:'same'}))]};
  const employment='77777777-7777-4777-8777-777777777777';
  let profile={employmentTypeId:employment,contract:structuredClone(policy.contract),rule:null,skills:input.tasks.map(t=>({taskId:t.id,level:1})),roleIds:[]};
  let plan={demand:[{date:'2026-10-01',start:540,end:570,taskId:input.tasks[0].id,direct:100,calculated:null}],events:[],roleRequirements:[]};
  let own={unavailable:[{date:'2026-10-02',start:600,end:630}],preferences:[]};
  const button=name=>page.getByRole('button',{name,exact:true}), region=name=>page.getByRole('region',{name,exact:true});
  const field=(scope,name,role)=>region(scope).getByRole(role??'spinbutton',{name,exact:true});
  const planningTab = title => page.getByRole('tab',{name:title,exact:true}).click();
  const actionLayout=async(group,pairs)=>{
    for(const width of [1280,1024,768,390,320]){
      await page.setViewportSize({width,height:1000});
      for(const [title,add] of pairs){
        if(group==='planning') await planningTab(title);
        const a=await button(add).boundingBox(),b=await button(title+'を保存').boundingBox();
        check(a&&b,'ACTION_MISSING_'+title);
        if(width>700)check(Math.abs(a.y-b.y)<1&&b.x>=a.x+a.width&&b.x-a.x-a.width<=16,'ACTIONS_NOT_ADJACENT_'+title+'_'+width);
        else check(b.y>=a.y+a.height&&Math.abs(a.x-b.x)<1,'MOBILE_ACTIONS_NOT_STACKED_'+title);
      }
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'ACTION_OVERFLOW_'+group+'_'+width);
      if(width===1280||width===320){if(group==='planning')await planningTab(pairs[0][0]);const file=output+'/actions-'+group+'-'+width+'.png';await region(pairs[0][0]).locator(':scope > .form-actions').screenshot({path:file});screenshots.push(file);}
    }
    results.push({actionLayout:group,headings:pairs.map(p=>p[0]),desktopWidths:[1280,1024,768],mobileWidths:[390,320],adjacentDesktop:true,stackedMobile:true,noOverflow:true});
    await page.setViewportSize({width:1280,height:1000});
  };
  const deadline={month:'2026-10',configuredDay:20,deadlineDate:'2026-09-20',timeZone:'Asia/Tokyo',closesAt:1};
  const wrap=payload=>payload===null?{version:null}:({version:{id:'synthetic-version',effectiveFrom:'2026-10',revision,payload}});
  const settle=async()=>page.waitForFunction(()=>!document.querySelector('.topbar button')?.disabled&&document.querySelectorAll('[data-slot=loading][aria-busy=true]').length===0);
  const save=async(name)=>{const before=calls.length;const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().startsWith(base+'/api/'));await button(name).click();await response;await settle();check(calls.length===before+1,'SAVE_CALL_COUNT_'+name);};
  page.removeAllListeners('dialog');page.on('dialog',dialog=>dialog.accept());await page.unrouteAll({behavior:'wait'});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
    const request=route.request(),u=new URL(request.url()),p=u.pathname;requests++;
    if(u.origin!==base||requests>450){unknown.push(p);await route.abort();return;}
    if(!p.startsWith('/api/')){await route.continue();return;}
    let body,status=200;
    if(request.method()==='POST'&&p.endsWith('/demand-csv/preview')){
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({month:'2026-10',inputRevision:revision,csvSha256:'a'.repeat(64),previewSha256:'b'.repeat(64),capacityScale:100,added:0,replaced:1,rows:[{line:2,demand:plan.demand[0],action:'REPLACE',errors:[]}]})});return;
    }
    if(request.method()==='POST'&&p.endsWith('/demand-csv/apply')){
      const data=request.postDataJSON();csvAttempts.push(data.operationId);calls.push({path:p,body:structuredClone(data)});
      await route.fulfill({status:csvAttempts.length===1?503:200,contentType:'application/json',body:JSON.stringify(csvAttempts.length===1?{error:'INTERNAL_ERROR'}:{id:data.operationId,revision:++revision,importedRows:1,rejectedRows:0,added:0,replaced:1,replayed:false,errors:[]})});return;
    }
    if(request.method()==='POST'){
      const data=request.postDataJSON();calls.push({path:p,body:structuredClone(data)});
      if(fail){status=fail==='conflict'?409:503;body={error:fail==='conflict'?'VERSION_CONFLICT':'INTERNAL_ERROR'};fail='';}
      else {
        check(data.expectedRevision===revision,'WRONG_REVISION');
        if(p.endsWith('/company-policy'))policy=data.payload;
        else if(p.endsWith('/config'))config=data.payload;
        else if(p.endsWith('/planning'))plan=data.payload;
        else if(p.endsWith('/contract')){if(p.includes(id.staff[1]))secondProfile=data.payload;else profile=data.payload;}
        else if(p.includes('/self-month/'))own=data.payload;
        else throw Error('UNKNOWN_WRITE');
        revision++;body={id:id.snapshot,revision,replayed:false};if(externalRefresh&&p.endsWith('/contract')){secondProfile={...secondProfile,roleIds:[]};externalRefresh=false;revision++;}
      }
    }else if(request.method()!=='GET'){unknown.push(p);await route.abort();return;}
    else if(p==='/api/access')body={userId:'synthetic',mustChange:false};
    else if(p==='/api/context')body={userId:'synthetic',companies:[{id:id.company,name:'見出し保存の架空企業',revision,role:'company_admin',teams:[{id:id.team,name:'架空チーム',role:null,staff_id:id.staff[0]}]}]};
    else if(p.endsWith('/staff'))body={staff:id.staff.map((staff,i)=>({id:staff,name:'架空スタッフ'+i,staff_number:'000'+i,user_id:'synthetic-'+i,role:'staff',status:'active'}))};
    else if(p.includes('/contract-options/'))body={revision,policy,employment:[{id:employment,version:employment,effectiveFrom:'2026-10',revision,payload:{name:'架空雇用区分',rule,contract:policy.contract}}],roleRounding:'ceil'};
    else if(p.includes('/company-policy/'))body=wrap(policy);
    else if(p.includes('/config/'))body=wrap(config);
    else if(p.includes('/planning/'))body=wrap(plan);
    else if(p.includes('/contract/'))body=wrap(p.includes(id.staff[1])?secondProfile:profile);
    else if(p.includes('/calendar-settings/'))body={version:{settings:{weekStart:0,deadlineDay:20,halfDayDivider:720,roleRounding:'ceil'}}};
    else if(p.endsWith('/jobs'))body={jobs:[]};
    else if(p.endsWith('/drafts'))body={draftRevision:0,draft:null};
    else if(p.endsWith('/publications'))body={publicationRevision:0,publication:null};
    else if(p.endsWith('/publications/history'))body={versions:[],nextCursor:null};
    else if(p.endsWith('/publications/notices'))body={notices:[],nextCursor:null};
    else if(p.includes('/self-month/'))body={month:'2026-10',revision,staffId:id.staff[0],calendarId:id.company,serverTime:1,deadline,window:null,accepting:true,version:{id:id.staff[0],revision,payload:own},patterns:config.patterns};
    else if(p.includes('/submission-window/'))body={month:'2026-10',serverTime:1,deadline,window:null};
    else {unknown.push(p);await route.abort();return;}
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  try {
    await page.goto(base+'/app?month=2026-10&section=company');await settle();
    step='company-layout';await actionLayout('company',[['習熟度の段階','段階を追加']]);
    step='company-independent';await field('勤務時間・休日のルール','日最大勤務（分）').fill('');
    await field('企業共通の勤務可能曜日・時間帯','勤務可能な終了時刻','combobox').selectOption('1260');
    await field('企業共通の休憩ルール','必要休憩（分）').fill('90');await save('企業共通の休憩ルールを保存');
    check(policy.rule.dailyMax===480&&policy.contract.end===1200&&policy.breakRule.requiredMinutes===90,'COMPANY_SCOPE_LEAK');
    check(await field('勤務時間・休日のルール','日最大勤務（分）').inputValue()===''&&await field('企業共通の勤務可能曜日・時間帯','勤務可能な終了時刻','combobox').inputValue()==='1260','COMPANY_DRAFT_LOST');
    check((await region('勤務時間・休日のルール').innerText()).includes('未保存'),'OTHER_DIRTY_CLEARED');
    await field('勤務時間・休日のルール','日最大勤務（分）').fill('420');await save('勤務時間・休日のルールを保存');await save('企業共通の勤務可能曜日・時間帯を保存');
    check(policy.rule.dailyMax===420&&policy.contract.end===1260&&policy.breakRule.requiredMinutes===90,'COMPANY_SAVED_BASE_LOST');
    results.push({companySectionIsolation:true,invalidOtherSectionAllowed:true,otherDraftAndDirtyRetained:true,sequentialSavedBase:true});
    step='failure';await field('企業共通の休憩ルール','必要休憩（分）').fill('120');fail='conflict';await save('企業共通の休憩ルールを保存');check(policy.breakRule.requiredMinutes===90&&(await region('企業共通の休憩ルール').innerText()).includes('未保存'),'CONFLICT_CLEARED_DRAFT');
    fail='unknown';await save('企業共通の休憩ルールを保存');check(await button('同じ操作を確認').count()===1,'MISSING_RETRY');const operation=calls.at(-1).body.operationId;await save('同じ操作を確認');check(calls.at(-1).body.operationId===operation&&policy.breakRule.requiredMinutes===120,'RETRY_CHANGED_OPERATION');
    results.push({conflictPreservesDirty:true,unknownResponseRetry:true});
    step='keyboard-scope';const keyboardResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/company-policy'));await field('企業共通の休憩ルール','必要休憩（分）').fill('150');await field('企業共通の休憩ルール','必要休憩（分）').press('Enter');await keyboardResponse;await settle();check(policy.breakRule.requiredMinutes===150,'ENTER_SAVED_WRONG_SECTION');results.push({keyboardSavesFocusedSection:true});
    step='team';await button('チーム設定').click();await settle();
    await actionLayout('team',[['業務','業務を追加'],['勤務パターン','勤務パターンを追加'],['担当区分','担当区分を追加']]);
    await field('チームの計算設定','計算全体の優先方式','combobox').selectOption('preference');
    await field('業務','最低継続時間（分）').first().fill('15');
    await field('勤務パターン','退勤時刻','combobox').selectOption('1050');await save('勤務パターンを保存');
    check(config.priority==='coverage'&&config.tasks[0].minimumMinutes===10&&config.patterns[0].end===1050,'TEAM_SCOPE_LEAK');
    check(await field('チームの計算設定','計算全体の優先方式','combobox').inputValue()==='preference'&&await field('業務','最低継続時間（分）').first().inputValue()==='15','TEAM_DRAFT_LOST');
    await save('業務を保存');await save('チームの計算設定を保存');check(config.tasks[0].minimumMinutes===15&&config.priority==='preference'&&config.patterns[0].end===1050,'TEAM_SAVED_BASE_LOST');results.push({teamSectionIsolation:true,teamOptionsRefreshPreservesDraft:true});
    step='related-team-settings';await button('業務を追加').click();const added=region('業務').locator('.setup-row').last();
    await added.getByRole('textbox',{name:'業務名',exact:true}).fill('追加業務');await added.getByRole('combobox',{name:'業務種別',exact:true}).selectOption('general');await added.getByRole('combobox',{name:'最低習熟度',exact:true}).selectOption('1');await added.getByRole('spinbutton',{name:'最低継続時間（分）',exact:true}).fill('10');await added.getByRole('combobox',{name:'この業務の担当区分評価',exact:true}).selectOption('same');
    for(const name of ['標準 の能力係数','熟練 の能力係数'])await added.getByRole('textbox',{name,exact:true}).fill('1');
    const beforeRelated=calls.length;await button('業務を保存').click();await region('業務').getByRole('alert').waitFor();check(calls.length===beforeRelated,'RELATED_FIELDS_SILENTLY_SAVED');
    const moves=region('切替時の準備・移動').getByRole('spinbutton');for(let i=0;i<await moves.count();i++)if(await moves.nth(i).inputValue()==='')await moves.nth(i).fill('0');
    step='coefficient-precision';await field('業務','標準 の能力係数','textbox').first().fill('0.5');await added.getByRole('textbox',{name:'熟練 の能力係数',exact:true}).fill('1.5');await field('チームの計算設定','能力係数の精度（100なら0.01刻み）').fill('1');
    const beforePrecision=calls.length;await button('すべてのチーム設定を保存').click();await page.getByRole('alert').filter({hasText:'能力係数の精度（現在1）'}).waitFor();check(calls.length===beforePrecision,'INEXACT_COEFFICIENT_SENT');check(await field('業務','標準 の能力係数','textbox').first().inputValue()==='0.5'&&await added.getByRole('textbox',{name:'熟練 の能力係数',exact:true}).inputValue()==='1.5','PRECISION_ERROR_LOST_INPUT');
    await field('チームの計算設定','能力係数の精度（100なら0.01刻み）').fill('100');
    await save('すべてのチーム設定を保存');check(config.tasks.length===3&&config.transitions.length===6,'RELATED_ALL_SAVE_FAILED');check(await region('業務').getByRole('textbox',{name:'業務名',exact:true}).last().getAttribute('readonly')!==null,'NEW_ID_STILL_EDITABLE');results.push({dependentChangeRejectedWithoutUnrelatedSave:true,explicitAllSaveForRelatedSettings:true});
    check(config.capacityScale===100&&config.tasks[0].capacities[0].capacity===50&&config.tasks[2].capacities[1].capacity===150,'COEFFICIENT_PRECISION_CHANGED_VALUES');results.push({fullSaveExplainsCoefficientPrecision:true,failedSaveRetainsDecimalInputs:true,precisionCorrectionSavesEditedAndNewTasksExactly:true});

    step='profile';await button('スタッフ管理').click();await settle();
    await field('勤務契約・個人ルール','勤務可能な開始時刻','combobox').selectOption('510');
    const skill=region('業務ごとの習熟度').getByRole('combobox').first();await skill.selectOption('2');await region('対応可能な担当').getByRole('checkbox').first().check();await save('対応可能な担当を保存');
    check(profile.contract.start===480&&profile.skills[0].level===1&&profile.roleIds.length===1,'PROFILE_SCOPE_LEAK');
    check(await skill.inputValue()==='2'&&await field('勤務契約・個人ルール','勤務可能な開始時刻','combobox').inputValue()==='510','PROFILE_DRAFT_LOST');
    await save('業務ごとの習熟度を保存');await save('勤務契約・個人ルールを保存');check(profile.contract.start===510&&profile.skills[0].level===2&&profile.roleIds.length===1,'PROFILE_SAVED_BASE_LOST');results.push({staffSectionIsolation:true,staffRefreshPreservesDraft:true});
    step='first-profile';await page.getByRole('combobox',{name:'契約を編集するスタッフ',exact:true}).selectOption(id.staff[1]);await settle();check(await button('対応可能な担当を保存').isDisabled(),'PARTIAL_FIRST_REGISTRATION');await region('対応可能な担当').getByRole('checkbox').first().check();await save('勤務契約・習熟度・対応可能な担当を登録');check(secondProfile?.roleIds.length===1&&!await button('対応可能な担当を保存').isDisabled(),'FIRST_REGISTRATION_NOT_ACKNOWLEDGED');results.push({firstRegistrationExplicit:true,sectionSavingEnabledAfterReceipt:true});
    step='external-update';await field('勤務契約・個人ルール','勤務可能な開始時刻','combobox').selectOption('510');await region('業務ごとの習熟度').getByRole('combobox').first().selectOption('2');externalRefresh=true;await save('業務ごとの習熟度を保存');await page.getByText('保存元の設定が更新されました。未保存の内容を確認し、ページを再読み込みして最新の設定を読み直してください。',{exact:true}).waitFor();check(await button('勤務契約・個人ルールを保存').isDisabled()&&await field('勤務契約・個人ルール','勤務可能な開始時刻','combobox').inputValue()==='510','EXTERNAL_UPDATE_DID_NOT_BLOCK_OR_RETAIN_DRAFT');results.push({externalChangeBlocksStaleSave:true,externalChangeRetainsDraft:true});
    // An explicit page reload acknowledges loss before leaving the stale editor.
    await page.reload();await settle();

    step='planning';await button('需要管理').click();await settle();
    await actionLayout('planning',[['必要人数','需要を追加'],['研修・会議','研修・会議を追加'],['担当区分の必要人数','担当区分の条件を追加']]);
    await planningTab('研修・会議');await button('研修・会議を追加').click();await planningTab('必要人数');await field('必要人数','需要 1 直接必要人数（空欄＝未設定）','textbox').fill('2');await save('必要人数を保存');
    check(plan.demand[0].direct===200&&plan.events.length===0,'PLAN_SCOPE_LEAK');await planningTab('研修・会議');check(await region('研修・会議').getByRole('textbox',{name:'予定 1 開始',exact:true}).inputValue()==='','EVENT_DRAFT_LOST');
    await field('研修・会議','予定 1 開始','textbox').fill('1007');await field('研修・会議','予定 1 終了','textbox').fill('1017');await field('研修・会議','予定 1 種別','combobox').selectOption('training');await region('研修・会議').getByRole('checkbox').first().check();await save('研修・会議を保存');check(plan.events[0].start===607&&plan.demand[0].direct===200,'PLANNING_BASE_LOST');results.push({planningSectionIsolation:true,incompleteOtherEventRetained:true});
    step='pending-bulk';await planningTab('必要人数');await button('期間を指定して必要人数の一括入力').click();await field('必要人数','一括入力 毎日の開始','textbox').fill('0900');await planningTab('担当区分の必要人数');await button('期間を指定して担当区分の条件を一括入力').click();await field('担当区分の必要人数','担当区分一括入力 毎日の開始','textbox').fill('0930');await planningTab('研修・会議');await save('研修・会議を保存');await planningTab('必要人数');check(await field('必要人数','一括入力 毎日の開始','textbox').inputValue()==='0900','OTHER_BULK_DRAFT_LOST');await button('一括入力をリセット').click();await planningTab('担当区分の必要人数');check(await field('担当区分の必要人数','担当区分一括入力 毎日の開始','textbox').inputValue()==='0930','ROLE_BULK_DRAFT_LOST');await button('担当区分一括入力をリセット').click();results.push({pendingDemandAndRoleBulkRetainedOnEventSave:true});

    step='csv-recovery';await button('需要CSVの取り込み').click();const csvDialog=page.getByRole('dialog',{name:'需要CSVの取り込み',exact:true});await csvDialog.waitFor();
    await page.getByLabel('需要CSVファイル',{exact:true}).setInputFiles({name:'fictional.csv',mimeType:'text/csv',buffer:Buffer.from('date,start,end,task_id,direct,calculated\n2026-10-01,09:00,09:30,phone,2,')});await csvDialog.getByRole('table',{name:'需要CSVプレビュー',exact:true}).waitFor();
    await button('正常行だけ反映').click();await csvDialog.getByRole('button',{name:'同じ操作を確認',exact:true}).waitFor();check(await button('需要CSVの取り込みを閉じる').isDisabled(),'UNKNOWN_CSV_CAN_CLOSE');
    await csvDialog.getByRole('button',{name:'同じ操作を確認',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.demand-csv-dialog button[aria-label="需要CSVの取り込みを閉じる"]')?.disabled);
    check(csvAttempts.length===2&&csvAttempts[0]===csvAttempts[1],'CSV_RETRY_NEW_OPERATION');check(await csvDialog.getByRole('table',{name:'需要CSVプレビュー',exact:true}).count()===0,'CSV_RECOVERY_PREVIEW_NOT_CLEARED');await button('需要CSVの取り込みを閉じる').click();await page.getByRole('heading',{name:'CSVの反映結果',exact:true}).waitFor();results.push({csvUnknownRecoveryInsideDialog:true,sameOperationId:true});

    step='submission';await button('勤務不可・希望').click();await settle();await actionLayout('submission',[['勤務不可日時','勤務不可を追加'],['勤務の希望','希望を追加']]);await button('希望を追加').click();await region('勤務の希望').getByRole('combobox',{name:'希望の種類',exact:true}).selectOption('window');await field('勤務不可日時','終了（HHMM、2400可）','textbox').fill('1037');await save('勤務不可日時を保存');
    check(own.unavailable[0].end===637&&own.preferences.length===0,'SUBMISSION_SCOPE_LEAK');check(await field('勤務の希望','希望時間帯の開始（30分単位）','textbox').inputValue()==='','PREFERENCE_DRAFT_LOST');await field('勤務の希望','希望時間帯の開始（30分単位）','textbox').fill('0900');await field('勤務の希望','希望時間帯の終了（30分単位）','textbox').fill('1700');await save('勤務の希望を保存');check(own.unavailable[0].end===637&&own.preferences[0].start===540,'SUBMISSION_BASE_LOST');results.push({staffMonthSectionIsolation:true,unrelatedPreferenceRetained:true});
    for(const width of [1280,390,320]){await page.setViewportSize({width,height:1000});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'OVERFLOW');const file=output+'/sections-'+width+'.png';await page.screenshot({path:file,fullPage:true});screenshots.push(file);}
    check(!unknown.length&&!errors.length,'UNEXPECTED_IO');return {passed:true,results,screenshots,requests,simulatedWrites:calls.length,backendWrites:0,errors,unknown,scope:'Real product assets with fictional HTTP reads and intercepted save acknowledgments; no backend writes or solve.'};
  } catch(error){throw Error('SECTION_SAVE_STEP_'+step+' '+error.message);}
}
