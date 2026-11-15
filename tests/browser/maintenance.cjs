async (page, stage) => {
 const assert=(ok,code)=>{if(!ok)throw Error(code);};
 const input=()=>page.getByRole('spinbutton',{name:'毎月の希望締切日',exact:true});
 const pending=()=>page.getByText('応答が不明な操作があります。',{exact:false});
 if(stage==='prepare'){
  await page.getByRole('button',{name:'企業共通ルール',exact:true}).click();await input().waitFor();await input().fill('23');
  await page.evaluate(()=>{
   window.__maintenanceProbe={ids:[],alerts:0,fetch:window.fetch,confirm:window.confirm,alert:window.alert};
   window.fetch=async(...args)=>{const [url,options]=args;if(typeof url==='string'&&url.endsWith('/calendar-settings')&&options?.body)window.__maintenanceProbe.ids.push(JSON.parse(options.body).operationId);return window.__maintenanceProbe.fetch.apply(window,args);};
   window.confirm=()=>true;window.alert=()=>{window.__maintenanceProbe.alerts++;};
  });
  return {stage,editedValue:await input().inputValue()};
 }
 if(stage==='stopped'){
  const response=page.waitForResponse(r=>r.url().endsWith('/calendar-settings')&&r.status()===503);
  await page.getByRole('button',{name:await pending().count()?'同じ操作を確認':'カレンダー設定を保存',exact:true}).click();await response;await pending().waitFor();
  assert(await input().inputValue()==='23','MAINTENANCE_LOST_INPUT');
  await page.getByRole('button',{name:'需要管理',exact:true}).click();
  assert(await input().count()===1,'MAINTENANCE_DISCARDED_PENDING_OPERATION');
  const values=await page.evaluate(()=>{
   const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);
   return {ids:window.__maintenanceProbe.ids,alerts:window.__maintenanceProbe.alerts,unload:event.defaultPrevented};
  });
  assert(values.ids.length>=1&&values.ids.every(id=>id===values.ids[0])&&values.alerts===1&&values.unload,'MAINTENANCE_MISSING_PENDING_GUARD');
  await page.screenshot({path:'output/playwright/maintenance-stopped.png',fullPage:true});
  return {stage,retainedValue:'23',pendingGuard:true,firstOperationId:values.ids[0],apiStatus:503};
 }
 if(stage==='resumed'){
  const response=page.waitForResponse(r=>r.url().endsWith('/calendar-settings')&&r.status()===200);
  await page.getByRole('button',{name:'同じ操作を確認',exact:true}).click();await response;
  await page.getByRole('status').filter({hasText:'保存しました。'}).waitFor();await input().waitFor();
  const values=await page.evaluate(()=>{
   const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);
   const ids=window.__maintenanceProbe.ids;
   window.fetch=window.__maintenanceProbe.fetch;window.confirm=window.__maintenanceProbe.confirm;window.alert=window.__maintenanceProbe.alert;delete window.__maintenanceProbe;
   return {ids,unload:event.defaultPrevented};
  });
  assert(values.ids.length>=2&&values.ids.every(id=>id===values.ids[0]),'MAINTENANCE_RETRY_CHANGED_ID');
  assert(!values.unload&&await input().inputValue()==='23','MAINTENANCE_SUCCESS_DID_NOT_CLEAR_GUARD');
  return {stage,savedValue:'23',sameOperationId:true,pendingGuardCleared:true,apiStatus:200};
 }
 throw Error('UNKNOWN_MAINTENANCE_BROWSER_STAGE');
}
