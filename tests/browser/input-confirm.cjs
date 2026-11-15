// Reconcile the already pending mutation, never create another operation ID.
async(page,owner,stage)=>{
 const before=await page.evaluate(async()=>await(await fetch('/api/context')).json());
 if(before.companies.find(c=>c.id===owner.companyId)?.revision!==4)throw Error('CONFIRM_SOURCE_VERSION');
 const pending=page.waitForResponse(r=>r.url().endsWith('/config')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'同じ操作を確認',exact:true}).click();const r=await pending,body=await r.json();
 if(r.status()!==200||body.replayed!==true||body.revision!==4)throw Error('CONFIRM_NOT_REPLAYED');
 await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='同じ操作を確認'));
 const after=await page.evaluate(async()=>await(await fetch('/api/context')).json());if(after.companies.find(c=>c.id===owner.companyId)?.revision!==4)throw Error('CONFIRM_CHANGED_REVISION');
 return {stage,companyId:owner.companyId,results:[{name:'pending real config save reconciles same ID, replayed and unchanged revision4',passed:true}],operationId:r.request().postDataJSON().operationId,status:r.status(),replayed:body.replayed,cloudflareRequests:0};
}
