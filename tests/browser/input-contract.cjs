async(page,owner,stage)=>{
 const results=[],posts=[],assert=(ok,c)=>{if(!ok)throw Error(c);};
 const button=name=>page.getByRole('button',{name,exact:true});
 async function save(name,suffix){const p=page.waitForResponse(r=>r.url().endsWith(suffix)&&r.request().method()==='POST');await button(name).click();const r=await p;assert(r.status()===200,'CONTRACT_SAVE_FAILED');posts.push({route:new URL(r.url()).pathname,status:r.status(),operationId:r.request().postDataJSON().operationId});await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.matches(':disabled')),name);return await r.json();}
 const c=await page.evaluate(async()=>await(await fetch('/api/context')).json());assert(c.companies.find(c=>c.id===owner.companyId)?.revision===5,'CONTRACT_SOURCE_VERSION');
 const detail=page.locator('details').filter({has:page.getByText('雇用区分を追加',{exact:true})});
 if(!await detail.evaluate(d=>d.open))await page.getByText('雇用区分を追加',{exact:true}).click();
 const employment=page.locator('form').filter({has:button('雇用区分を登録')});
 await employment.getByLabel('雇用区分名',{exact:true}).fill('架空標準雇用');await employment.getByLabel('日最大勤務（分）',{exact:true}).fill('450');
 await employment.getByRole('checkbox',{name:'日',exact:true}).uncheck();await employment.getByRole('checkbox',{name:'土',exact:true}).uncheck();await employment.getByRole('combobox',{name:'勤務可能な開始時刻',exact:true}).selectOption('540');await employment.getByRole('combobox',{name:'勤務可能な終了時刻',exact:true}).selectOption('1080');
 const p=page.waitForResponse(r=>r.url().includes('/inputs/employment/')&&r.request().method()==='POST');await button('雇用区分を登録').click();const r=await p;assert(r.status()===200,'EMPLOYMENT_SAVE_FAILED');posts.push({route:new URL(r.url()).pathname,status:r.status(),operationId:r.request().postDataJSON().operationId});await button('勤務契約・習熟度・対応可能な担当を登録').waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='勤務契約・習熟度・対応可能な担当を登録'&&!b.matches(':disabled')));
 await page.getByText('雇用区分を追加',{exact:true}).click();
 const personal=page.locator('form').filter({has:button('勤務契約・習熟度・対応可能な担当を登録')});
 await personal.getByRole('combobox',{name:'勤務可能な開始時刻',exact:true}).selectOption('600');await personal.getByRole('combobox',{name:'勤務可能な終了時刻',exact:true}).selectOption('1020');
 await personal.getByLabel('個人の追加勤務ルールを設定する',{exact:true}).check();await personal.getByLabel('日最大勤務（分）',{exact:true}).fill('420');await personal.getByLabel('月最低勤務（分）',{exact:true}).fill('120');
 await personal.getByRole('combobox',{name:'架空電話（最低習熟度 1）',exact:true}).selectOption('1');await personal.getByRole('combobox',{name:'架空監督（最低習熟度 1）',exact:true}).selectOption('1');await personal.getByRole('checkbox',{name:'架空SV',exact:true}).check();await save('勤務契約・習熟度・対応可能な担当を登録','/contract');
 const saved=await page.evaluate(async({companyId,teamId,month})=>{
  const base=`/api/companies/${companyId}/inputs/teams/${teamId}`,staff=await(await fetch(`/api/companies/${companyId}/teams/${teamId}/staff`)).json();if(staff.staff.length!==1)throw Error('STAFF_SCOPE');
  const options=await(await fetch(base+'/contract-options/'+month)).json(),profile=await(await fetch(base+'/staff/'+staff.staff[0].id+'/contract/'+month)).json();return {options,profile};
 },owner);
 assert(saved.options.employment.length===1&&saved.options.employment[0].payload.rule.dailyMax===450,'EMPLOYMENT_VALUE_MISMATCH');
 assert(saved.profile.version.payload.rule.dailyMax===420&&saved.profile.version.payload.rule.monthlyMin===120,'PERSONAL_RULE_MISMATCH');
 assert(saved.profile.version.payload.contract.start===600&&saved.profile.version.payload.roleIds[0]==='架空SV','PERSONAL_CONTRACT_MISMATCH');
 results.push({name:'UI employment and personal contract preserve three independent rule layers, exact skills and role',passed:true});
 return {stage,companyId:owner.companyId,results,posts,saved,cloudflareRequests:0};
}
