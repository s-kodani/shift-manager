async page => {
  page.setDefaultTimeout(15000);
  page.removeAllListeners('dialog'); page.on('dialog', current => current.accept());
  const origin = 'http://127.0.0.1:8799', output = 'output/playwright/solver-result-help';
  const check = (value, code) => { if (!value) throw Error(code); };
  const button = (name, target = page) => target.getByRole('button', { name, exact: true });
  const results = page.getByRole('dialog', { name: '計算結果', exact: true });
  const popup = page.getByRole('dialog', { name: '探索結果の説明', exact: true });
  const trigger = () => button('探索結果の説明', results);
  const state = async data => (await page.request.post(origin + '/__test/state', { data })).json();
  const defaults = { role:'company_admin', stale:false, status:'VERIFIED', cycle:0, publicationCycle:0, manual:false, noCandidate:false, noPublication:false,
    candidateStatus:'VERIFIED', candidateViolations:[], candidateHistory:[], jobState:'SUCCEEDED', noAssignments:false, resultFailure:false,
    publishFailure:'', publishDelay:0, snapshotFailure:false, fixedFailure:false, missing:false, readinessFailure:false, certificateFailure:false,
    generalShortage:60, roleSameShortage:0, solverStatus:null, writes:[], requests:{} };
  const errors = [], writes = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url()); });
  const load = async (patch = {}) => {
    await state({ ...defaults, ...patch }); await page.goto(origin + '/app?month=2026-10');
    await page.locator('.candidate-monthly').waitFor();
    if (!patch.noAssignments) await page.locator('.draft-editor').waitFor();
    await button('計算結果').click(); await results.waitFor();
  };
  const closeHelp = async () => {
    await button('説明を閉じる', popup).click(); await popup.waitFor({ state:'hidden' });
    check(await trigger().evaluate(el => el === document.activeElement), 'CLOSE_FOCUS');
    check(await results.isVisible(), 'PARENT_CLOSED');
  };
  const bounds = async (target, width, height) => {
    const rect = await target.boundingBox();
    check(rect && rect.x >= 15.5 && rect.x + rect.width <= width - 15.5 && rect.y >= 15.5 && rect.y + rect.height <= height - 15.5, 'POPUP_BOUNDS_' + width + '_' + height + '_' + JSON.stringify(rect));
    check(await target.evaluate(el => el.scrollWidth <= el.clientWidth), 'CONTENT_OVERFLOW');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'PAGE_OVERFLOW');
  };
  let step = 'states';
  try {
    await page.setViewportSize({ width:1280, height:900 });
    const cases = [
      ['FEASIBLE','有効案あり・最良値は未証明','シフト案は見つかっていますが、一番よい案かは確認できていません。','これよりよい案が存在しないとは、まだ言い切れないこと','100件中90件','blue'],
      ['OPTIMAL','最良値を確認済み','今回の条件と優先順位では、これよりよい評価の案はありません。','すべての希望がかなうことや、不足がゼロになることを意味するわけではありません。','91件以上は不可能','blue'],
      ['UNKNOWN','探索内で案を発見できませんでした','今回の探索では、シフト案を見つけられませんでした。','「案を見つけられなかった」と「案が存在しない」は異なります。','有効な案がある可能性','amber'],
      ['INFEASIBLE','解なしを証明','今回の入力条件では、必須条件をすべて満たすシフト案を作れません。','同じ条件のまま計算時間を延ばしても、有効な案は得られません。','80時間','amber'],
      ['MODEL_INVALID','モデルの検査に失敗','計算の準備段階で問題が見つかり、探索結果を判断できませんでした。','シフト案が存在しないと確認されたわけではありません。','どちらも判断できません','red'],
      [null,'手動編集案・最適性は未証明','手動編集した案のため、最良かどうかは確認していません。','ほかの組み合わせとの比較による最適性の確認は行っていません。','月曜日から火曜日へ変更','gray'],
      ['UNRECOGNIZED','UNRECOGNIZED','この探索状態の説明を表示できません。','制約検証・エラー表示を確認してください。',null,'gray'],
      ['toString','toString','この探索状態の説明を表示できません。','制約検証・エラー表示を確認してください。',null,'gray'],
    ];
    for (const [status,label,conclusion,meaning,example,tone] of cases) {
      await load({ solverStatus:status, manual:status === null, noAssignments:['UNKNOWN','INFEASIBLE','MODEL_INVALID'].includes(status) });
      const tile = results.locator('.stats > div').first();
      check(await tile.locator('.solver-result-value > strong').innerText() === label, 'LABEL_' + status);
      await trigger().click(); await popup.waitFor();
      check(await popup.locator('.solver-help-badge').innerText() === label, 'BADGE_' + status);
      check(await popup.locator('.solver-help-conclusion h3').innerText() === conclusion, 'CONCLUSION_' + status);
      check((await popup.locator('.solver-help-meaning').innerText()).includes(meaning), 'MEANING_' + status);
      check(await popup.locator('.solver-help-' + tone).count() === 1, 'TONE_' + status);
      check(await popup.getByText('勤務ルールの確認結果は『制約検証』タイルで確認してください。', {exact:true}).count() === 1, 'GUIDE_' + status);
      if (example) check((await popup.getByRole('region', {name:'説明用の例'}).innerText()).includes(example), 'EXAMPLE_' + status);
      else check(await popup.locator('.solver-help-example').count() === 0, 'INVENTED_EXAMPLE');
      check(await trigger().getAttribute('aria-expanded') === 'true', 'ARIA_EXPANDED');
      check(await trigger().getAttribute('aria-controls') === await popup.getAttribute('id'), 'ARIA_CONTROLS');
      check(await popup.evaluate(el => !el.closest('[aria-hidden=true]') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent === '探索結果の説明'), 'ACCESSIBLE_POPUP');
      await bounds(popup,1280,900); await closeHelp();
    }
    checks.push('all five solver states, manual edit, unknown/prototype fallback: label, conclusion, meaning, examples, tone, guide and accessible names');

    step = 'mouse-keyboard'; await load();
    await button('計算結果を閉じる',results).focus();
    await trigger().hover(); await popup.waitFor(); await popup.hover(); await page.waitForTimeout(220);
    check(await popup.isVisible(), 'HOVER_TRANSFER'); await page.mouse.move(2,2); await popup.waitFor({state:'hidden'});
    await trigger().focus(); await popup.waitFor(); await page.keyboard.press('Enter');
    await page.keyboard.press('Escape'); await popup.waitFor({state:'hidden'});
    check(await results.isVisible() && await trigger().evaluate(el=>el===document.activeElement), 'ESCAPE_PARENT_OR_FOCUS');
    await page.keyboard.press('Space'); await popup.waitFor(); await closeHelp();
    await page.keyboard.press('Enter'); await popup.waitFor();
    await page.keyboard.press('Tab');
    check(await button('説明を閉じる',popup).evaluate(el=>el===document.activeElement), 'POPUP_FOCUS_TRAP');
    await page.keyboard.press('Shift+Tab');check(await trigger().evaluate(el=>el===document.activeElement),'POPUP_BACK_TAB');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape'); await popup.waitFor({state:'hidden'}); check(await results.isVisible(), 'ESCAPE_FROM_POPUP');
    await trigger().click(); await popup.waitFor(); await results.locator('.stats > div').nth(1).click(); await popup.waitFor({state:'hidden'});
    check(await results.isVisible(), 'OUTSIDE_PARENT');
    await page.keyboard.press('Escape'); await results.waitFor({state:'hidden'});
    check(await button('計算結果').evaluate(el=>el===document.activeElement), 'RESULT_FOCUS');
    checks.push('hover transfer/dismissal, Enter/Space, first Escape closes only help, popup focus, outside click, second Escape closes results and returns focus');

    step = 'layout';
    for (const [width,height] of [[1280,900],[390,844],[320,700],[320,360]]) {
      await page.setViewportSize({width,height}); await load(); await trigger().click(); await popup.waitFor(); await bounds(popup,width,height);
      const typography = await popup.evaluate(el=>{const s=getComputedStyle(el),h=getComputedStyle(el.querySelector('.solver-help-conclusion h3'));return {font:s.fontSize,line:s.lineHeight,heading:h.fontSize,width:el.getBoundingClientRect().width};});
      check(typography.font==='14px'&&typography.heading==='16px'&&Math.abs(parseFloat(typography.line)-23.8)<0.1,'TYPOGRAPHY');
      if(width===1280)check(typography.width===420,'DESKTOP_WIDTH');
      if(height===360){
        check(await popup.evaluate(el=>el.scrollHeight>el.clientHeight),'NO_INTERNAL_SCROLL');
        await popup.hover(); await page.mouse.wheel(0,300); await page.waitForFunction(()=>document.querySelector('.solver-help-popup')?.scrollTop>0);
      }
      await page.screenshot({path:output+'/help-'+width+'x'+height+'.png'});
      await page.keyboard.press('Escape'); await popup.waitFor({state:'hidden'}); check(await results.isVisible(),'SMALL_ESCAPE');
    }
    checks.push('420px desktop card; 390/320px and short viewport: 16px edges, internal wheel scrolling, typography and screenshots');

    step = 'unsaved'; await page.setViewportSize({width:1280,height:900}); await load(); await button('計算結果を閉じる',results).click();
    const editor=page.locator('.draft-editor > details'); await editor.locator('summary').click();
    const fixed=editor.getByRole('checkbox',{name:'勤務パターンを固定',exact:true,includeHidden:true}); await fixed.check();
    await button('計算結果').click(); await trigger().click(); await popup.waitFor(); await closeHelp(); await button('計算結果を閉じる',results).click();
    check(await fixed.isChecked(),'UNSAVED_LOST');check(await page.getByRole('alertdialog').count()===0,'UNSAVED_PROMPT');
    step='source-change'; await load({manual:true});await trigger().click();await popup.waitFor();
    await page.getByRole('button',{name:'計算した案',exact:true,includeHidden:true}).evaluate(el=>el.click());await results.waitFor({state:'hidden'});await popup.waitFor({state:'hidden'});
    await button('計算結果').click();check(await popup.count()===0,'SOURCE_HELP_RESTORED');
    checks.push('unsaved editor preserved; source switch closes help/results and reopening starts closed');

    step='touch'; await state(defaults);
    const touchContext=await page.context().browser().newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
    try {
      const touch=await touchContext.newPage();touch.on('pageerror',e=>errors.push(e.message));
      touch.on('request',r=>{if(r.method()!=='GET'&&new URL(r.url()).pathname.startsWith('/api/'))writes.push(r.url());});
      const tap=async locator=>{await locator.scrollIntoViewIfNeeded();const r=await locator.boundingBox();await touch.touchscreen.tap(r.x+r.width/2,r.y+r.height/2);};
      await touch.goto(origin+'/app?month=2026-10');await touch.locator('.draft-editor').waitFor();await tap(button('計算結果',touch));
      const help=touch.getByRole('dialog',{name:'探索結果の説明',exact:true}),outer=touch.getByRole('dialog',{name:'計算結果',exact:true});
      for(const width of [390,320]){
        await touch.setViewportSize({width,height:844});const icon=button('探索結果の説明',outer);await tap(icon);await help.waitFor();
        check((await help.innerText()).includes('100件中90件'),'TOUCH_COPY');await help.evaluate(el=>el.scrollTop=0);await tap(button('説明を閉じる',help));await help.waitFor({state:'hidden'});
        check(await outer.isVisible()&&await icon.evaluate(el=>el===document.activeElement),'TOUCH_CLOSE');
        await tap(icon);await help.waitFor();await tap(icon);await help.waitFor({state:'hidden'});
      }
    } finally {await touchContext.close();}
    checks.push('real touch events on 390/320px: open, close, icon toggle and focus restoration');
    check(!writes.length,'BUSINESS_WRITES_'+writes.join(','));check(!errors.length,'PAGE_ERRORS_'+errors.join(','));
    await state({solverStatus:null});
    return {passed:true,checks,errors,writes,widths:[1280,390,320],scope:'real built UI and fictional local API; no solver, real data or Cloudflare'};
  } catch(error) { throw Error('SOLVER_HELP_STEP '+step+' '+error.message); }
}
