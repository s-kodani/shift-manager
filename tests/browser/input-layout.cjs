async(page,owner,stage)=>{
 const staff=stage==='layout-staff',results=[];await page.setViewportSize(staff?{width:390,height:844}:{width:1280,height:900});
 if(!staff){
  await page.getByRole('button',{name:'チーム設定',exact:true}).click();
  if(await page.getByRole('alert').filter({hasText:'別の変更が保存されています。再読込して差分を確認してください。'}).count()){
   const loaded=page.waitForEvent('load');await page.getByRole('button',{name:'最新の入力を読み直す（未保存の入力は破棄）',exact:true}).click();await loaded;
   await page.getByRole('button',{name:'チーム設定',exact:true}).click();
   results.push({name:'other-user submission input revision conflict explicitly reloaded before editing',passed:true});
  }
  await page.getByRole('button',{name:'すべてのチーム設定を保存',exact:true}).waitFor();
 }
 if(await page.getByRole('textbox',{name:'発行した初期パスワード',exact:true}).count())throw Error('SECRET_STILL_VISIBLE');
 const target=staff?page.getByRole('button',{name:'勤務不可を追加',exact:true}):page.getByRole('combobox',{name:'業務配置枠',exact:true});await target.focus();await page.keyboard.press('Tab');
 const measure=await page.evaluate(()=>{
  const body=document.querySelector('.panel-body'),panel=body.parentElement,grid=body.querySelector('.form-grid'),field=grid.querySelector('.field'),active=document.activeElement;
  const style=getComputedStyle(body),g=getComputedStyle(grid),a=getComputedStyle(active),p=panel.getBoundingClientRect(),r=field.getBoundingClientRect();
  return {viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyPaddingLeft:parseFloat(style.paddingLeft),bodyPaddingRight:parseFloat(style.paddingRight),gridGap:parseFloat(g.rowGap),fieldDirection:getComputedStyle(field).flexDirection,fieldInsetLeft:r.left-p.left,fieldInsetRight:p.right-r.right,activeTag:active.tagName,focusOutlineStyle:a.outlineStyle,focusOutlineWidth:parseFloat(a.outlineWidth),localStorage:localStorage.length,sessionStorage:sessionStorage.length};
 });
 if(measure.documentWidth>measure.viewport||measure.bodyPaddingLeft<(staff?16:24)||measure.bodyPaddingRight<(staff?16:24)||measure.gridGap<24||measure.fieldDirection!=='column'||measure.focusOutlineStyle==='none'||measure.focusOutlineWidth<2||measure.localStorage||measure.sessionStorage)throw Error('LAYOUT_OR_KEYBOARD_CHECK_FAILED');
 await page.evaluate(()=>scrollTo(0,0));const screenshot=owner.artifact+'/'+(staff?'submission-mobile.png':'team-settings-pc.png');await page.screenshot({path:screenshot,fullPage:!staff});
 results.push({name:'panel inset,24px grid gaps, vertical labels, no page overflow, keyboard focus and no browser storage',passed:true});
 return {stage,companyId:owner.companyId,results,measure,screenshot,cloudflareRequests:0};
}
