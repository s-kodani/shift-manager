async(page)=>{
  if(new URL(page.url()).hostname!=='localhost')throw Error('LOCAL_ONLY');
  const results=[];
  let confirmCount=0;
  const dismiss=async()=>{const dialog=page.getByRole('alertdialog');await dialog.waitFor();confirmCount++;await dialog.getByRole('button',{name:'編集を続ける',exact:true}).click();};
  const warn=()=>page.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented;});
  try {
    await page.getByRole('button',{name:'チーム設定',exact:true}).click();
    await page.getByRole('button',{name:'業務を追加',exact:true}).waitFor();
    if(await warn())throw Error('CLEAN_TEAM_DIRTY');
    const rows=await page.getByRole('button',{name:'業務を削除',exact:true}).count();
    await page.getByRole('button',{name:'業務を追加',exact:true}).click();
    await page.getByRole('button',{name:'需要管理',exact:true}).click(); await dismiss();
    if(await page.locator('h1').innerText()!=='チーム設定'||!await warn())throw Error('STRUCTURAL_EDIT_LOST');
    await page.getByRole('button',{name:'業務を削除',exact:true}).nth(rows).click();
    if(await warn())throw Error('UNDO_STRUCTURAL_EDIT_REMAINS_DIRTY');
    results.push({name:'controlled add/cancel-navigation/delete restores the original clean draft',passed:true});
    await page.getByRole('button',{name:'スタッフ管理',exact:true}).click();
    await page.getByLabel('取り込みファイル',{exact:true}).setInputFiles('tests/fixtures/unsaved-csv-selection.csv');
    await page.getByText('unsaved-csv-selection.csv',{exact:false}).waitFor();
    await page.getByRole('button',{name:'需要管理',exact:true}).click(); await dismiss();
    if(await page.locator('h1').innerText()!=='スタッフ管理'||!await warn())throw Error('CSV_SELECTION_LOST');
    await page.getByRole('button',{name:'全件中止',exact:true}).click();
    if(await warn())throw Error('ABANDONED_CSV_REMAINS_DIRTY');
    results.push({name:'CSV selection is protected and explicit abandonment clears the flag; no import applied',passed:true});
    return {results,confirmChoices:'real shadcn Alert Dialog',confirmCount};
  }finally{if(await page.getByRole('alertdialog').count())await page.getByRole('button',{name:'編集を続ける',exact:true}).click();}
}
