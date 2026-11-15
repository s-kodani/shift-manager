async(page)=>{
 const check=(condition,message)=>{if(!condition)throw Error(message);};
 const results=[];
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:1000});await page.goto('http://127.0.0.1:8798/');
  const card=page.getByRole('region',{name:'シフト計算の準備'}).or(page.locator('.readiness-panel'));
  await card.getByText('警告',{exact:true}).waitFor();
  check(!await page.getByRole('button',{name:'シフトを計算',exact:true}).isDisabled(),'WARNING_BLOCKED');
  check(await card.getByRole('status').textContent()==='警告が1件あります。内容を確認のうえ計算できます。','SUMMARY');
  check(await card.getByText('完了',{exact:true}).count()===8,'WARNING_COUNTED_COMPLETE');
  const example=card.getByText('未登録の需要枠（先頭12件／全742件）',{exact:true});
  check(await example.isVisible(),'EXAMPLES_COLLAPSED');
  await card.getByText('2026-10-01 09:00〜09:30 ／ 業務：架空電話受付業務',{exact:true}).waitFor();
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'OVERFLOW_'+width);
  await page.screenshot({path:`output/playwright/demand-readiness-${width}.png`,fullPage:true});
  await card.getByRole('button',{name:'対象月の需要・予定の設定を確認',exact:true}).click();
  check(await page.getByRole('status',{name:'移動先'}).textContent()==='demand','NAVIGATION');
  await page.getByRole('button',{name:'全枠入力済み',exact:true}).click();
  await card.getByText('計算を開始できます。',{exact:true}).waitFor();
  check(await card.getByText('完了',{exact:true}).count()===9,'COMPLETE_COUNT');
  await page.getByRole('button',{name:'需要未保存',exact:true}).click();
  await card.getByText('未設定',{exact:true}).waitFor();
  check(await page.getByRole('button',{name:'シフトを計算',exact:true}).isDisabled(),'UNSAVED_ENABLED');
  results.push({width,warningVisible:true,examplesExpanded:true,navigation:true,completeCount:true,unsavedBlocked:true,noOverflow:true});
 }
 return {passed:true,syntheticComponent:true,results,solverStarts:0};
}
