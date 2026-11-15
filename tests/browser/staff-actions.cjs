async(page,owner)=>{
 if(!['localhost','127.0.0.1'].includes(new URL(page.url()).hostname))throw Error('LOCAL_ONLY');
 const button=name=>page.getByRole('button',{name,exact:true});
 if(owner.stage==='password'){
  await page.getByRole('textbox',{name:'現在のパスワード',exact:true}).fill(owner.password);
  const password=owner.password+'Changed';
  await page.getByRole('textbox',{name:'新しいパスワード（12〜128文字）',exact:true}).fill(password);
  await page.getByRole('textbox',{name:'新しいパスワードをもう一度',exact:true}).fill(password);
  await button('変更して利用を開始').click();
  await page.getByRole('heading',{name:'公開済みのシフト',exact:true}).waitFor();
  return {stage:'password',passed:true};
 }
 if(owner.stage==='login'){
  await page.getByRole('textbox',{name:'メールアドレス',exact:true}).fill(owner.email);
  await page.getByRole('textbox',{name:'パスワード',exact:true}).fill(owner.password);
  await button('ログイン').click();await page.getByRole('heading',{name:'公開済みのシフト',exact:true}).or(page.getByRole('heading',{name:'初回パスワードの変更',exact:true})).waitFor();
  return {stage:'login',passed:true};
 }
 const check=(value,code)=>{if(!value)throw Error(code);};
 const screenshots=[],results=[];
 const capture=async name=>{const file=owner.output+'/'+name+'.png';await page.screenshot({path:file,fullPage:false});screenshots.push(file);};
 if(owner.stage==='staff'){
  await page.getByRole('button',{name:'シフトを計算',exact:true}).waitFor();
  await button('スタッフ管理').click();
  await page.getByRole('heading',{name:'スタッフ一覧',exact:true}).waitFor();
  const row=page.getByRole('row').filter({hasText:'架空入力スタッフ'});
  const trigger=()=>row.getByRole('button',{name:'架空入力スタッフの操作メニュー',exact:true});
  const item=name=>page.getByRole('menuitem',{name,exact:true});
  const status=async(name,action)=>{await trigger().click();await item(name).click();await page.getByRole('alertdialog').waitFor();await page.getByRole('alertdialog').getByRole('button',{name:action,exact:true}).click();};
  await page.setViewportSize({width:1280,height:900});
  await page.keyboard.press('Escape');
  await trigger().click();await page.getByRole('menu').waitFor();
  check(await page.getByRole('menuitem').count()===3,'MENU_ITEM_COUNT');
  check(await row.getByRole('button',{name:'管理者を付与',exact:true}).count()===0,'INLINE_ROLE_ACTION');
  await capture('staff-menu-1280');
  await page.keyboard.press('ArrowDown');check(await item('非アクティブ化').evaluate(el=>el===document.activeElement),'MENU_ARROW_FOCUS');
  await page.keyboard.press('Escape');check(await trigger().evaluate(el=>el===document.activeElement),'MENU_FOCUS_RETURN');
  await trigger().click();await item('管理者を付与').click();await row.getByText('チーム管理者',{exact:true}).waitFor();
  await trigger().click();await item('管理者を解除').click();await row.getByText('スタッフ',{exact:true}).waitFor();
  await status('非アクティブ化','キャンセル');check(await row.getByText('アクティブ',{exact:true}).count()===1,'CANCEL_CHANGED_STATUS');
  await status('非アクティブ化','非アクティブ化する');await row.getByText('非アクティブ',{exact:true}).waitFor();
  await trigger().click();check(await item('管理者を付与').isDisabled(),'INACTIVE_ROLE_ACTION');await page.keyboard.press('Escape');
  await status('再有効化','再有効化する');await row.getByText('アクティブ',{exact:true}).waitFor();
  await page.reload();await page.getByRole('button',{name:'シフトを計算',exact:true}).waitFor();await button('スタッフ管理').click();await trigger().waitFor();
  for(const width of [390,320]){
   await page.setViewportSize({width,height:900});await trigger().click();await page.getByRole('menu').waitFor();
   const rect=await page.getByRole('menu').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,document:document.documentElement.scrollWidth};});
   check(rect.left>=8&&rect.right<=width-8&&rect.bottom<=rect.height&&rect.document<=width,'MENU_OVERFLOW_'+JSON.stringify(rect));
   await capture('staff-menu-'+width);await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:1280,height:900});
  await trigger().click();await item('削除').click();await page.getByRole('alertdialog').waitFor();await capture('staff-delete-confirmation');await button('キャンセル').click();check(await row.count()===1,'DELETE_CANCEL');
  await status('削除','削除する');await row.waitFor({state:'hidden'});
  await page.reload();await page.getByRole('button',{name:'シフトを計算',exact:true}).waitFor();await button('スタッフ管理').click();await page.getByRole('heading',{name:'スタッフ一覧',exact:true}).waitFor();check(await row.count()===0,'DELETE_NOT_PERSISTED');
  results.push({name:'role grant/revoke, cancel/deactivate/reactivate/delete, reload, keyboard and mobile menu',passed:true});
 }else if(owner.stage==='spacing'){
  await button('シフト・計算結果').click();await page.locator('.candidate-monthly').waitFor();
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:900});
   const gap=await page.locator('.candidate-monthly > .panel').evaluate(el=>el.querySelector(':scope > .panel-body').firstElementChild.getBoundingClientRect().top-el.querySelector(':scope > h2').getBoundingClientRect().bottom);
   check(gap>=24,'SCHEDULE_TITLE_SPACING');results.push({width,gap});await capture('schedule-spacing-'+width);
  }
 }else if(owner.stage==='policy'){
  await button('企業共通ルール').click();await button('すべての企業共通設定を保存').waitFor();
  for(const width of [1280,390,320]){
   await page.setViewportSize({width,height:900});
   const layout=await page.locator('.skill-level-row').first().evaluate(el=>{
    const remove=el.querySelector('button'),field=el.querySelector('.field'),a=remove.getBoundingClientRect(),b=field.getBoundingClientRect();
    return {removeRight:a.right,fieldLeft:b.left,icon:!!remove.querySelector('svg'),text:remove.textContent.trim(),width:innerWidth,document:document.documentElement.scrollWidth};
   });
   check(layout.removeRight<layout.fieldLeft&&layout.icon&&layout.text===''&&layout.document<=width,'SKILL_REMOVE_LAYOUT');
   const gap=await button('段階を追加').evaluate(el=>{
    const a=el.getBoundingClientRect(),b=[...el.parentElement.querySelectorAll('button')].find(el=>el.textContent.includes('すべての企業共通設定を保存')).getBoundingClientRect();
    return Math.max(b.left-a.right,b.top-a.bottom);
   });
   check(gap>=12,'POLICY_ACTION_SPACING');results.push({width,gap,...layout});
   await page.locator('.skill-level-row').first().scrollIntoViewIfNeeded();await capture('policy-levels-'+width);
  }
  const before=await page.locator('.skill-level-row').count();await button('段階を追加').click();check(await page.locator('.skill-level-row').count()===before+1,'SKILL_ADD');
  await button('段階 '+(before+1)+' を削除').click();check(await page.locator('.skill-level-row').count()===before,'SKILL_REMOVE');
  await page.reload();
 }
 return {stage:owner.stage,passed:true,results,screenshots};
}