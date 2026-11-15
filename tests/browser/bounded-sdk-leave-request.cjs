async(page)=>{
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('OWNED_LOCAL_APP_REQUIRED');
 await page.getByRole('button',{name:'休暇・欠勤',exact:true}).click();
 await page.getByRole('combobox',{name:'受付の種類',exact:true}).selectOption('LEAVE_REQUEST');
 await page.getByRole('combobox',{name:'対象の公開勤務',exact:true}).selectOption('2026-10-02');
 await page.getByRole('combobox',{name:'対象範囲',exact:true}).selectOption('FULL');
 await page.getByRole('textbox',{name:'申請・記録の理由',exact:true}).fill('架空の全日休暇。大規模固定解除・取消・再配置の検証');
 const pending=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/leave'),{timeout:30000});
 await page.getByRole('button',{name:'申請を送信',exact:true}).click();const response=await pending,receipt=await response.json();
 if(response.status()!==200)throw Error('OWN_LEAVE_REQUEST_FAILED');
 await page.getByRole('heading',{name:'2026-10-02 · 全日 · 休暇申請',exact:true}).waitFor();
 return {status:response.status(),receipt,submittedByOwnStaffUi:true};
}
