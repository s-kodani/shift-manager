async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 const editor=page.locator('.draft-editor');if(!await editor.locator('details').evaluate(el=>el.open))await editor.locator('summary').click();
 await editor.getByRole('combobox',{name:'編集するスタッフ',exact:true}).selectOption({label:'架空スタッフ0001'});
 await editor.getByRole('combobox',{name:'編集する日',exact:true}).selectOption('2026-10-02');
 if(await editor.getByRole('combobox',{name:'勤務パターン',exact:true}).inputValue()!=='')throw Error('EXPECTED_UNAVAILABLE_DAY_OFF');
 const staffId=await editor.getByRole('combobox',{name:'編集するスタッフ',exact:true}).inputValue();
 await editor.getByRole('combobox',{name:'勤務パターン',exact:true}).selectOption('long');
 await editor.getByRole('textbox',{name:'休憩開始',exact:true}).fill('0930');
 await editor.getByRole('textbox',{name:'休憩終了',exact:true}).fill('1000');
 if(await editor.getByRole('combobox',{name:'業務 09:30',exact:true}).count()!==0)throw Error('REST_ONLY_TASK_REMAINS');
 await editor.getByRole('textbox',{name:'休憩終了',exact:true}).fill('1030');
 await editor.getByRole('textbox',{name:'休憩開始',exact:true}).fill('1000');
 if(await editor.getByRole('combobox',{name:'業務 09:30',exact:true}).count()!==1||await editor.getByRole('combobox',{name:'業務 10:00',exact:true}).count()!==0)throw Error('MOVED_REST_TASKS_MISMATCH');
 await editor.getByRole('textbox',{name:'休憩開始',exact:true}).fill('0930');
 await editor.getByRole('textbox',{name:'休憩終了',exact:true}).fill('1000');
 await editor.getByRole('button',{name:'理由付き例外を追加',exact:true}).click();
 await editor.getByRole('textbox',{name:'例外の開始',exact:true}).fill('0900');
 await editor.getByRole('textbox',{name:'例外の終了',exact:true}).fill('0930');
 await editor.getByRole('textbox',{name:'手動配置の理由',exact:true}).fill('架空の勤務不可例外。本人と管理者で確認済み');
 for(const name of['勤務パターンを固定','出退勤を固定','休憩を固定'])await editor.getByRole('checkbox',{name,exact:true}).check();
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/drafts'),{timeout:90000});
 await editor.getByRole('button',{name:'検証して編集案を保存',exact:true}).click();const r=await response,data=await r.json();if(r.status()!==200||data.draftRevision!==1)throw Error('REST_EDIT_SAVE_REJECTED:'+JSON.stringify(data));
 await page.getByRole('button',{name:'保存済みの編集案（版1）',exact:true}).waitFor();
 const proof=await page.evaluate(async staffId=>{
  const u=new URL(location.href),base='/api/companies/'+u.searchParams.get('company')+'/schedules/teams/'+u.searchParams.get('team'),head=await(await fetch(base+'/drafts?month=2026-10')).json(),d=head.draft,a=d.assignments.find(a=>a.staffId===staffId&&a.date==='2026-10-02'),lock=d.locks.find(l=>l.staffId===staffId&&l.date===a.date),exception=d.exceptions.find(e=>e.staffId===staffId&&e.date===a.date);
  if(d.validation.status!=='VERIFIED'||d.assignments.length!==15500||a.shift.start!==540||a.shift.end!==720||a.shift.breakKind!=='auto'||JSON.stringify(a.shift.break)!=='[570,600]'||a.shift.workedMinutes!==150||a.blocks.some(b=>b.start===570)||JSON.stringify([...lock.parts].sort())!=='["break","pattern","time"]'||exception.start!==540||exception.end!==570||!exception.reason)throw Error('REST_EDIT_PROOF_MISMATCH');
  return {draftId:d.draftId,draftRevision:head.draftRevision,staffId,date:a.date,shift:a.shift,parts:lock.parts,blocks:a.blocks,exception,validationStatus:d.validation.status,objectiveVector:d.validation.objectiveVector};
 },staffId);
 return {saveStatus:r.status(),receipt:data,restOnlyTaskRemoved:true,movedRestRestoredWork:true,proof};
}
