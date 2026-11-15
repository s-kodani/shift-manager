// Real UI registration from an empty owned company; no preloaded masters.
async(page,owner,stage)=>{
 const results=[],posts=[],assert=(ok,code)=>{if(!ok)throw Error(code);},button=name=>page.getByRole('button',{name,exact:true});
 const field=(role,name)=>page.getByRole(role,{name,exact:true});
 const record=name=>results.push({name,passed:true});
 const context=()=>page.evaluate(async()=> (await (await fetch('/api/context')).json()));
 const current=(await context()).companies.find(c=>c.id===owner.companyId);assert(current,'SOURCE_COMPANY_MISSING');
 async function save(name,suffix){
  const waiting=page.waitForResponse(r=>r.url().endsWith(suffix)&&r.request().method()==='POST');await button(name).click();const r=await waiting;
  posts.push({route:new URL(r.url()).pathname,status:r.status(),operationId:r.request().postDataJSON().operationId});assert(r.status()===200,'SETUP_SAVE_FAILED');
  const body=await r.json();await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===label&&!b.matches(':disabled')),name);
  return body;
 }
 if(stage==='setup'){
 assert(current.teams.length===0,'SOURCE_NOT_EMPTY');
 await field('textbox','新しいチーム名').fill('架空画面受入チーム');await save('チームを作成','/teams');
 await page.waitForFunction(()=>new URL(location.href).searchParams.get('team')!=='');
 const teamId=new URL(page.url()).searchParams.get('team');assert(teamId,'TEAM_NOT_SELECTED');record('empty company creates and selects a team via UI');
 await field('combobox','週の開始曜日').selectOption('0');await field('spinbutton','毎月の希望締切日').fill('31');await field('combobox','午前・午後の境界時刻').selectOption('720');await field('combobox','担当区分人数の端数処理').selectOption('floor');await save('カレンダー設定を保存','/calendar-settings');
 const rule=[['日最大勤務（分）','480'],['週最大勤務（分）','2400'],['月最低勤務（分）','60'],['月最大勤務（分）','12000'],['月最低勤務日数','1'],['月最低休日数','4'],['最大連続勤務日数','6']];
 for(const [name,value] of rule)await field('spinbutton',name).fill(value);
 for(const day of ['日','月','火','水','木','金','土'])await field('checkbox',day).check();
 await field('combobox','勤務可能な開始時刻').selectOption('480');await field('combobox','勤務可能な終了時刻').selectOption('1200');
 await field('combobox','必要休憩の算定基準').selectOption('elapsed');
 for(const [name,value] of [['休憩が必要になる勤務時間（分・超過時）','360'],['必要休憩（分）','60'],['勤務開始から取得可能になるまで（分）','120'],['勤務終了までに残す時間（分）','60']])await field('spinbutton',name).fill(value);
 await field('spinbutton','段階 1 の番号').fill('0');await field('textbox','段階 1 の名称').fill('初級');await button('段階を追加').click();await field('spinbutton','段階 2 の番号').fill('1');await field('textbox','段階 2 の名称').fill('標準');await save('企業共通設定をすべて登録','/company-policy');
 record('company calendar and common work/break rules registered without fixture defaults');
 }else{
  assert(['setup-team','setup-staff'].includes(stage)&&current.teams.length===1&&current.revision===(stage==='setup-team'?3:4),'SETUP_RESUME_NOT_AT_EXPECTED_VERSION');
  record('explicit continuation retains already saved company/team versions');
 }
 const teamId=new URL(page.url()).searchParams.get('team');assert(teamId,'TEAM_NOT_SELECTED');
 if(stage!=='setup-staff'){
 await button('チーム設定').click();await button('チーム設定をすべて登録').waitFor();
 for(const [name,value] of [['業務配置枠','30'],['計算全体の優先方式','coverage'],['チーム全体の担当区分評価','first']])await field('combobox',name).selectOption(value);
 await field('spinbutton','能力係数の精度（100なら0.01刻み）').fill('100');
 await field('textbox','業務名').fill('架空電話');await field('combobox','業務種別').selectOption('general');await field('combobox','最低習熟度').selectOption('1');await field('spinbutton','最低継続時間（分）').fill('10');await field('combobox','この業務の担当区分評価').selectOption('same');await field('textbox','初級 の能力係数').fill('0.5');await field('textbox','標準 の能力係数').fill('1');
 await button('業務を追加').click();await field('textbox','業務名').nth(1).fill('架空監督');await field('combobox','業務種別').nth(1).selectOption('dedicated');await field('combobox','最低習熟度').nth(1).selectOption('1');await field('spinbutton','最低継続時間（分）').nth(1).fill('10');
 await field('textbox','勤務パターン名').fill('架空日勤');await field('combobox','出勤時刻').selectOption('600');await field('combobox','退勤時刻').selectOption('1020');await field('combobox','休憩の決め方').selectOption('fixed');await field('combobox','固定休憩の開始').selectOption('780');await field('combobox','固定休憩の終了').selectOption('840');
 await button('担当区分を追加').click();await field('textbox','担当区分名').fill('架空SV');await field('checkbox','架空電話').check();
 await field('spinbutton','架空電話 → 架空監督（分）').fill('7');await field('spinbutton','架空監督 → 架空電話（分）').fill('7');await save('チーム設定をすべて登録','/config');
 assert(await field('combobox','必要休憩の算定基準').count()===0,'TEAM_CAN_EDIT_COMMON_BREAK');record('team registers tasks, exact7-minute transitions, pattern/role and refers to common break rule');
 }
 await button('スタッフ管理').click();await field('textbox','スタッフ番号').fill('B0001');await field('textbox','氏名').fill('架空画面受入スタッフ');
 const email='input-'+crypto.randomUUID()+'@example.invalid';await field('textbox','メールアドレス').fill(email);
 const issued=await save('登録・初期パスワード発行','/staff');assert(issued.initialPassword&&issued.staffId,'STAFF_ISSUANCE_INCOMPLETE');
 await button('閉じる').click();assert(await field('textbox','発行した初期パスワード').count()===0,'ISSUED_SECRET_REMAINS_VISIBLE');
 const saved=await page.evaluate(async({companyId,teamId,month})=>{
  const routes=[`/api/companies/${companyId}/calendar-settings/${month}`,`/api/companies/${companyId}/inputs/company-policy/${month}`,`/api/companies/${companyId}/inputs/teams/${teamId}/config/${month}`];
  const rows=[];for(const route of routes){const r=await fetch(route);rows.push({route,status:r.status,body:await r.json()});}return rows;
 },{...owner,teamId});
 assert(saved.every(r=>r.status===200),'SETUP_READ_FAILED');
 record('staff registered via UI and one-time password display closed before capture');
 return {stage,companyId:owner.companyId,teamId,results,posts,saved,privateStaff:{staffId:issued.staffId,email,initialPassword:issued.initialPassword},cloudflareRequests:0};
}
