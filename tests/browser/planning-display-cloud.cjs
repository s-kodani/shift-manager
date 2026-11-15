// Real served product assets; the caller intercepts every business API with fictional reads.
async (page, {base, output}) => {
  const check=(ok,code)=>{if(!ok)throw Error(code);};
  const button=(name,target=page)=>target.getByRole('button',{name,exact:true});
  const tab=name=>page.getByRole('tab',{name,exact:true});
  const field=name=>page.getByLabel(name,{exact:true});
  const errors=[],screenshots=[],widths=[1280,390,320],results=[];
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.accept());
  for(const width of widths){
    await page.setViewportSize({width,height:900});
    await page.goto(base+'/app?month=2026-10&section=demand');
    await button('需要を追加').waitFor();
    check(await tab('必要人数').getAttribute('aria-selected')==='true','DEFAULT_TAB');
    const bulk=button('期間を指定して必要人数の一括入力');
    check(await bulk.getAttribute('aria-expanded')==='false','DEMAND_NOT_COLLAPSED');
    const month=await field('対象月').boundingBox(),csv=await button('需要CSVの取り込み').boundingBox();
    check(width===1280?csv.x>=month.x+month.width-1&&Math.abs(csv.y-month.y)<2:csv.y>=month.y,'CSV_CONTROL_ORDER_'+width);
    await bulk.click();await field('一括入力 毎日の開始').fill('0900');await bulk.click();await bulk.press('Enter');
    check(await field('一括入力 毎日の開始').inputValue()==='0900','COLLAPSE_LOST_INPUT');
    await tab('担当区分の必要人数').click();
    const role=button('期間を指定して担当区分の条件を一括入力');check(await role.getAttribute('aria-expanded')==='false','ROLE_NOT_COLLAPSED');
    await role.click();await field('担当区分一括入力 毎日の開始').fill('0930');
    await tab('研修・会議').click();await page.getByRole('heading',{name:'研修・会議',exact:true}).waitFor();
    await tab('必要人数').click();check(await field('一括入力 毎日の開始').inputValue()==='0900','TAB_LOST_INPUT');
    await button('一括入力をリセット').click();await bulk.click();
    await tab('担当区分の必要人数').click();check(await field('担当区分一括入力 毎日の開始').inputValue()==='0930','ROLE_TAB_LOST_INPUT');
    await button('担当区分一括入力をリセット').click();await role.click();await tab('必要人数').click();
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'DEMAND_OVERFLOW_'+width);
    let path=output+'/demand-'+width+'.png';await page.screenshot({path,fullPage:true});screenshots.push(path);
    await button('需要CSVの取り込み').click();const modal=page.getByRole('dialog',{name:'需要CSVの取り込み',exact:true});await modal.waitFor();
    check(await field('需要CSVファイル').isEnabled(),'CSV_FILE_DISABLED');
    const bounds=await modal.boundingBox();check(bounds.x>=0&&bounds.x+bounds.width<=width,'CSV_MODAL_OVERFLOW');
    path=output+'/csv-'+width+'.png';await page.screenshot({path});screenshots.push(path);
    await page.keyboard.press('Escape');await modal.waitFor({state:'hidden'});
    await page.waitForFunction(()=>document.activeElement?.textContent?.trim()==='需要CSVの取り込み');
    results.push({width,tabs:true,collapsedBulk:true,inputRetained:true,csvControl:true,csvDialog:true});
  }
  await page.goto(base+'/app?month=2026-10&section=schedule');await page.locator('.candidate-monthly .month-table').waitFor();
  const refresh=button('最新のお知らせを読み直す');
  await page.waitForFunction(()=>!document.querySelector('.notice-heading button')?.disabled);
  check(await refresh.innerText()===''&&await refresh.getAttribute('title')==='最新のお知らせを読み直す','REFRESH_LABEL');
  await refresh.focus();await refresh.press('Enter');await page.waitForFunction(()=>!document.querySelector('.notice-heading button')?.disabled);
  await page.locator('.publication-disclosure > summary').click();await button('計算時からの変更の説明').click();
  const comparison=page.getByRole('dialog',{name:'計算時からの変更',exact:true});await comparison.waitFor();
  const input=()=>comparison.getByRole('region',{name:'入力条件の変更',exact:true});
  const publication=()=>comparison.getByRole('region',{name:'公開版・公開勤務の変化',exact:true});
  await input().getByText('52件の変更（50件を表示）',{exact:true}).waitFor();
  await publication().getByText('3件の変更（0件を表示）',{exact:true}).waitFor();
  await button('次の50件を確認',comparison).click();await publication().getByText('3件の変更（3件を表示）',{exact:true}).waitFor();
  await input().getByText('52件の変更（52件を表示）',{exact:true}).waitFor();
  for(const width of widths){
    await page.setViewportSize({width,height:900});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'COMPARISON_OVERFLOW');
    const path=output+'/changes-'+width+'.png';await page.screenshot({path});screenshots.push(path);
  }
  await button('説明を閉じる',comparison).click();
  for(const width of widths){
    await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));
    const icon=await refresh.boundingBox(),title=await page.getByRole('heading',{name:'自分へのシフトのお知らせ',exact:true}).boundingBox();
    check(icon.x>=title.x+title.width&&Math.abs(icon.y-title.y)<2,'REFRESH_NOT_TOP_RIGHT_'+width);
    const path=output+'/notice-'+width+'.png';await page.screenshot({path});screenshots.push(path);
  }
  check(errors.length===0,'PAGE_ERRORS');
  return {passed:true,results,categoryTotals:{input:52,publication:3},pagination:true,refreshKeyboard:true,widths,screenshots,pageErrors:errors};
}
