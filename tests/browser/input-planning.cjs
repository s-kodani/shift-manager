async(page,owner,stage)=>{
 const results=[],posts=[],assert=(ok,c)=>{if(!ok)throw Error(c);},b=name=>page.getByRole('button',{name,exact:true}),f=(role,name)=>page.getByRole(role,{name,exact:true});
 const current=await page.evaluate(async()=>await(await fetch('/api/context')).json());assert(current.companies.find(c=>c.id===owner.companyId)?.revision===7,'PLANNING_SOURCE_VERSION');
 async function save(name,suffix){const pending=page.waitForResponse(r=>r.url().endsWith(suffix)&&r.request().method()==='POST');await b(name).click();const r=await pending;assert(r.status()===200,'PLANNING_SAVE_FAILED');posts.push({route:new URL(r.url()).pathname,status:r.status(),operationId:r.request().postDataJSON().operationId});await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.matches(':disabled')),name);}
 await b('需要管理').click();await b('需要を追加').waitFor();await b('需要を追加').click();
 for(const [name,value] of [['需要 1 日付','2026-10-01'],['需要 1 開始','1000'],['需要 1 終了','1030'],['需要 1 直接必要人数（空欄＝未設定）','0']])await page.getByLabel(name,{exact:true}).fill(value);
 await f('combobox','需要 1 業務').selectOption('架空電話');
 await page.getByRole('tab',{name:'研修・会議',exact:true}).click();
 for(const [i,date,start,end,kind] of [[1,'2026-10-01','1007','1017','training'],[2,'2026-10-02','1017','1047','meeting']]){
  await b('研修・会議を追加').click();for(const [name,value] of [[`予定 ${i} 日付`,date],[`予定 ${i} 開始`,start],[`予定 ${i} 終了`,end]])await page.getByLabel(name,{exact:true}).fill(value);
  await f('combobox',`予定 ${i} 種別`).selectOption(kind);await page.getByRole('region',{name:`予定 ${i}`,exact:true}).getByRole('checkbox',{name:'B0001 架空画面受入スタッフ',exact:true}).check();
 }
 await page.getByRole('tab',{name:'担当区分の必要人数',exact:true}).click();await b('担当区分の条件を追加').click();for(const [name,value] of [['担当区分の条件 1 日付','2026-10-01'],['担当区分の条件 1 開始','1000'],['担当区分の条件 1 終了','1030']])await page.getByLabel(name,{exact:true}).fill(value);
 await f('combobox','担当区分の条件 1 対象範囲').selectOption(JSON.stringify('架空電話'));await f('combobox','担当区分の条件 1 担当区分').selectOption('架空SV');
 for(const [name,value] of [['担当区分の条件 1 最低人数','1'],['担当区分の条件 1 比率の分子','1'],['担当区分の条件 1 比率の分母','5']])await f('spinbutton',name).fill(value);
 await save('すべての需要・予定・担当区分を保存','/planning');
 const base=`/api/companies/${owner.companyId}/inputs/teams/${owner.teamId}`;
 const saved=await page.evaluate(async route=>await(await fetch(route)).json(),base+'/planning/'+owner.month);const p=saved.version.payload;
 assert(p.demand[0].direct===0&&p.demand[0].calculated===null,'ZERO_UNSET_MISMATCH');assert(p.events[0].start===607&&p.events[0].end===617&&p.events[1].start===617&&p.events[1].end===647,'EVENT_MINUTES_ROUNDED');assert(p.roleRequirements[0].ratioNumerator===1&&p.roleRequirements[0].ratioDenominator===5,'ROLE_RATIO_MISMATCH');results.push({name:'UI direct0 differs from unset; training/meeting exact minutes and role ratio persisted',passed:true});
 await b('勤務履歴').click();await b('確認した履歴を保存').waitFor();
 const before=await page.evaluate(async route=>await(await fetch(route)).json(),base+'/history/'+owner.month);assert(before.missing.length>0,'NO_HISTORY_BOUNDARY_CASE');
 for(const row of before.missing){await page.getByRole('group',{name:row.date+'の勤務履歴',exact:true}).getByRole('spinbutton',{name:'勤務時間(分)',exact:true}).fill('0');await page.getByRole('group',{name:row.date+'の勤務履歴',exact:true}).getByRole('textbox',{name:'確認の根拠',exact:true}).fill('架空入力受入: 前月末の休日を確認');}
 await save('確認した履歴を保存','/history');const history=await page.evaluate(async route=>await(await fetch(route)).json(),base+'/history/'+owner.month);assert(history.missing.length===0,'HISTORY_STILL_MISSING');results.push({name:'UI confirms missing preceding-month history with0-minute holidays and evidence',passed:true});
 return {stage,companyId:owner.companyId,results,posts,saved,historyDays:before.missing.length,historyMissing:history.missing.length,cloudflareRequests:0};
}
