// Credential-bearing UI phase: do not trace, snapshot or return credential data.
async(page,provided,stage)=>{
 const initial=provided.initialPassword,newPassword=provided.newPassword;
 if(!initial||!newPassword)throw Error('AUTH_OWNER_MISSING');
 await page.getByRole('textbox',{name:'メールアドレス',exact:true}).fill(provided.email);
 await page.getByRole('textbox',{name:'パスワード',exact:true}).fill(initial);
 await page.getByRole('button',{name:'ログイン',exact:true}).click();
 await page.getByRole('heading',{name:'初回パスワードの変更',exact:true}).waitFor();
 const before=await page.evaluate(async()=> (await fetch('/api/context')).status);if(before!==403)throw Error('INITIAL_BUSINESS_GATE_MISSING');
 await page.getByLabel('現在のパスワード',{exact:true}).fill(initial);
 await page.getByLabel('新しいパスワード（12〜128文字）',{exact:true}).fill(newPassword);
 await page.getByLabel('新しいパスワードをもう一度',{exact:true}).fill(newPassword);
 const response=page.waitForResponse(r=>r.url().endsWith('/api/password')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'変更して利用を開始',exact:true}).click();if((await response).status()!==200)throw Error('INITIAL_CHANGE_FAILED');
 await page.getByRole('button',{name:'ログアウト',exact:true}).waitFor();
 const context=await page.evaluate(async()=>{const r=await fetch('/api/context');return {status:r.status,body:await r.json()};});
 if(context.status!==200||!context.body.companies.some(c=>c.id===provided.companyId))throw Error('AUTH_CONTEXT_SCOPE');
 return {stage,companyId:provided.companyId,privateCookies:Object.fromEntries((await page.context().cookies()).map(c=>[c.name,c.value])),results:[{name:'first-password change required and business API403',passed:true},{name:'browser password change and current owned context200',passed:true}],cloudflareRequests:0};
}
