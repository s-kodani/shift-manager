async page => {
  page.setDefaultTimeout(15000);
  page.removeAllListeners('dialog'); page.on('dialog', current => current.accept());
  const origin = 'http://127.0.0.1:8799', output = 'output/playwright/schedule-actions';
  const check = (value, code) => { if (!value) throw Error(code); };
  const button = (name, target = page) => target.getByRole('button', { name, exact: true });
  const dialog = name => page.getByRole('dialog', { name, exact: true });
  const state = async data => (await page.request.post(origin + '/__test/state', { data })).json();
  const defaults = { role:'company_admin', stale:false, status:'VERIFIED', cycle:0, publicationCycle:0, manual:false, noCandidate:false, noPublication:false,
    candidateStatus:'VERIFIED', candidateViolations:[], candidateHistory:[], jobState:'SUCCEEDED', noAssignments:false, resultFailure:false,
    publishFailure:'', publishDelay:0, snapshotFailure:false, fixedFailure:false, missing:false, readinessFailure:false, certificateFailure:false,
    generalShortage:60, roleSameShortage:0, writes:[], requests:{} };
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  const load = async (patch = {}, query = '') => {
    await state({ ...defaults, ...patch });
    await page.goto(origin + '/app?month=2026-10&extra=keep' + query + '#anchor');
    await page.locator('.candidate-monthly').waitFor();
    if (patch.noAssignments) await page.getByText('この計算では勤務案を得られていません。',{exact:true}).waitFor();
    else if (!patch.noCandidate && !patch.resultFailure && patch.jobState !== 'RUNNING') await page.locator('.draft-editor').waitFor();
  };
  const publications = async () => (await state({})).writes.filter(row => row.path.endsWith('/publications'));
  const close = async name => {
    const help = dialog('探索結果の説明');
    if (name === '計算結果' && await help.isVisible()) {
      await page.keyboard.press('Escape'); await help.waitFor({state:'hidden'});
      check(await dialog(name).isVisible(), 'HELP_ESCAPE_CLOSED_RESULTS');
    }
    await button(name === 'シフトを公開' ? '公開確認を閉じる' : name + 'を閉じる', dialog(name)).click();
    await dialog(name).waitFor({ state:'hidden' }); await page.waitForFunction(label => document.activeElement?.textContent === label, name);
  };
  let step = 'collapsed';
  try {
    await page.setViewportSize({ width:1280, height:900 });
    await load({ stale:true, manual:true, status:'PENDING' });
    const disclosure = page.locator('.publication-disclosure'), summary = disclosure.locator('summary');
    check(!await disclosure.evaluate(el => el.open), 'DEFAULT_OPEN');
    check(await button('シフトを公開').isDisabled(), 'STALE_PUBLISH');
    check(await button('計算ボタンへ').count() === 0, 'COMPUTE_LINK_REMAINS');
    check(!Object.keys((await state({})).requests).some(path => path.endsWith('/changes')), 'CHANGES_EAGER');
    await summary.press('Enter'); check(await disclosure.evaluate(el => el.open), 'KEYBOARD_EXPAND');
    await button('計算時からの変更の説明').click();
    await dialog('計算時からの変更').getByText('55件の変更（50件を表示）', { exact:true }).waitFor();
    await button('説明を閉じる', dialog('計算時からの変更')).click();
    await page.clock.install(); await state({ cycle:1 }); await page.clock.fastForward(3100);
    await page.waitForFunction(() => document.querySelector('.publication-validation [role=status]')?.textContent.includes('再検証待ち'));
    check(await disclosure.evaluate(el => el.open), 'POLL_COLLAPSED'); await page.clock.resume();
    await button('計算した案').click(); check(!await disclosure.evaluate(el => el.open), 'SOURCE_NOT_COLLAPSED');
    await summary.click(); await page.reload(); await page.locator('.draft-editor').waitFor();
    check(!await disclosure.evaluate(el => el.open), 'RELOAD_OPEN');
    results.push('collapsed advice, lazy input info, keyboard, polling persistence, source/reload reset');

    step = 'eligibility';
    const fixture = await (await page.request.get(origin + '/__test/fixture')).json();
    for (const patch of [ {candidateStatus:'INVALID',candidateViolations:['WORKED_MINUTES']}, {candidateStatus:'HISTORY_UNVERIFIED',candidateHistory:[fixture.staff[0].id+':2026-09-30']}, {candidateStatus:'NOT_RUN'}, {jobState:'RUNNING'}, {noCandidate:true}, {resultFailure:true} ]) {
      await load(patch); check(await button('シフトを公開').isDisabled(), 'BLOCKER_ENABLED_' + JSON.stringify(patch));
      if (patch.noCandidate || patch.resultFailure || patch.jobState === 'RUNNING') check(await button('計算結果').isDisabled(), 'RESULT_ENABLED');
    }
    await load({ noAssignments:true }); check(await button('シフトを公開').isDisabled(), 'NO_ASSIGNMENTS_PUBLISH');
    await button('計算結果').click(); await dialog('計算結果').getByText('探索内で案を発見できませんでした', { exact:true }).waitFor(); await close('計算結果');
    results.push('all publication blockers, loading/failure/active states, no-solution results remain inspectable');

    step = 'publish'; await load();
    check(await page.locator('.publication-guidance').count() === 0, 'READY_GUIDANCE');
    check(await page.getByRole('tablist', { name:'案の表示' }).count() === 0, 'TABS_REMAIN');
    const adjacency = await button('シフトを公開').evaluate(el => el.previousElementSibling?.id === 'schedule-compute-action');
    check(adjacency, 'PUBLISH_POSITION');
    await button('シフトを公開').click();
    const publish = dialog('シフトを公開');
    check(await button('再検証して公開', publish).isDisabled(), 'ACK_BYPASSED');
    await publish.getByRole('checkbox').check(); await close('シフトを公開');
    check(await button('シフトを公開').evaluate(el => el === document.activeElement), 'PUBLISH_FOCUS');
    await button('シフトを公開').click(); check(!await publish.getByRole('checkbox').isChecked(), 'ACK_NOT_RESET');
    await publish.getByRole('checkbox').check(); await state({ publishDelay:250 });
    await button('再検証して公開', publish).evaluate(el => { el.click(); el.click(); });
    await publish.waitFor({ state:'hidden' });
    check((await publications()).length === 1, 'DUPLICATE_PUBLISH');
    const written = (await publications())[0].body;
    check(written.acknowledgeShortage === true && written.source.kind === 'job' && written.source.id === fixture.job && written.expectedRevision === 52 && written.expectedPublicationRevision === 2, 'PUBLICATION_TARGET');
    await page.getByRole('link', { name:'公開済み勤務のCSVをダウンロード' }).waitFor();
    results.push('adjacent trigger, modal acknowledgement reset, double-submit protection, exact job/revisions, success close/update');

    step = 'publish-failure'; await load({ generalShortage:0, manual:true, publishFailure:'unavailable' });
    await button('シフトを公開').click(); check(await publish.getByRole('checkbox').count() === 0, 'FALSE_SHORTAGE');
    await button('再検証して公開', publish).click(); await button('同じ操作を確認', publish).waitFor();
    check(await page.locator('main').getByRole('button',{name:'シフトを公開',exact:true,includeHidden:true}).isDisabled(), 'PENDING_REOPEN');
    await state({ publishFailure:'' }); await button('同じ操作を確認', publish).click(); await publish.waitFor({ state:'hidden' });
    const retried = await publications();
    check(retried.length === 2 && retried[0].body.operationId === retried[1].body.operationId && retried[0].body.source.kind === 'draft', 'RETRY_ID_OR_DRAFT');
    await load({generalShortage:0,publishFailure:'conflict'});await button('シフトを公開').click();await button('再検証して公開',publish).click();await publish.getByRole('alert').waitFor();
    check(await button('同じ操作を確認',publish).count()===0,'CONFLICT_PENDING');await close('シフトを公開');
    results.push('draft publication, no-shortage confirm, visible failure, same-ID uncertain retry, conflict feedback');

    step = 'unsaved-results'; await load();
    const editor = page.locator('.draft-editor > details'); await editor.locator('summary').click();
    const fixed = editor.getByRole('checkbox', { name:'勤務パターンを固定', exact:true, includeHidden:true }); await fixed.check();
    await button('計算結果').click(); await dialog('計算結果').getByRole('heading', {name:'不足人数',exact:true}).waitFor();
    await dialog('計算結果').getByRole('heading', {name:'配置結果の説明',exact:true}).waitFor();
    check(await page.getByRole('alertdialog').count() === 0, 'RESULT_DISCARD');
    await page.keyboard.press('Escape'); await dialog('計算結果').waitFor({ state:'hidden' });
    check(await button('計算結果').evaluate(el => el === document.activeElement) && await fixed.isChecked(), 'RESULT_FOCUS_OR_EDIT');
    await button('シフトを公開').click(); await publish.getByRole('checkbox').check(); await button('再検証して公開',publish).click();
    await page.getByRole('alertdialog').waitFor(); await button('編集を続ける',page.getByRole('alertdialog')).click();
    check(await fixed.isChecked() && (await publications()).length === 0, 'UNSAVED_PUBLICATION_BYPASSED'); await close('シフトを公開');
    results.push('results include explanation, Escape/focus, editor preservation, publication retains unsaved guard');

    step = 'responsive';
    for (const width of [1280,390,320]) {
      await load({stale:true});await page.setViewportSize({width,height:900});await page.locator('.publication-disclosure > summary').click();
      await page.locator('.candidate-monthly').scrollIntoViewIfNeeded();await page.screenshot({path:output+'/advice-'+width+'.png'});
      await button('計算結果').click();
      const bounds = await dialog('計算結果').boundingBox();check(bounds.x>=11&&bounds.x+bounds.width<=width-11,'RESULT_OVERFLOW_'+width);
      await page.keyboard.press('Tab');check(await dialog('計算結果').evaluate(el=>el.contains(document.activeElement)),'FOCUS_TRAP');
      await page.screenshot({path:output+'/results-'+width+'.png'});await close('計算結果');
      await load();await button('シフトを公開').click();await page.screenshot({path:output+'/publish-'+width+'.png'});await close('シフトを公開');
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'PAGE_OVERFLOW_'+width);
    }
    step = 'legacy'; for (const legacy of ['monthly','result','daily']) {
      await load({},'&tab='+legacy);check(!new URL(page.url()).searchParams.has('tab'),'LEGACY_TAB');
      check(new URL(page.url()).searchParams.get('extra')==='keep'&&new URL(page.url()).hash==='#anchor','UNRELATED_URL');
      await button('計算結果').click();await page.reload();await page.locator('.draft-editor').waitFor();check(await dialog('計算結果').count()===0,'MODAL_RESTORED');
    }
    step='source-invalidation';await load({manual:true});await button('計算結果').click();await page.getByRole('button',{name:'計算した案',exact:true,includeHidden:true}).evaluate(el=>el.click());await dialog('計算結果').waitFor({state:'hidden'});
    await button('シフトを公開').click();await page.getByRole('button',{name:'保存済みの編集案（版1）',exact:true,includeHidden:true}).evaluate(el=>el.click());await publish.waitFor({state:'hidden'});
    results.push('PC/390/320 layout, no tabs, URL migration, no modal restore, source change closes both dialogs');
    step='publication-invalidation';
    for (const name of ['計算結果','シフトを公開']) {
      await load({status:'PENDING'});await page.locator('.publication-validation').waitFor();
      await button(name).click();await dialog(name).waitFor();await page.clock.install();await state({publicationCycle:1});await page.clock.fastForward(3100);
      await dialog(name).waitFor({state:'hidden'});await page.clock.resume();
    }
    results.push('asynchronous publication revision changes close both dialogs');
    step='touch';await state({...defaults,stale:true});
    const touchContext=await page.context().browser().newContext({hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
    try {
      const touch=await touchContext.newPage(),tap=async locator=>{await locator.scrollIntoViewIfNeeded();const box=await locator.boundingBox();await touch.touchscreen.tap(box.x+box.width/2,box.y+box.height/2);};
      await touch.goto(origin+'/app?month=2026-10');await touch.locator('.draft-editor').waitFor();
      const folded=touch.locator('.publication-disclosure');check(!await folded.evaluate(el=>el.open),'TOUCH_DEFAULT_OPEN');
      await tap(folded.locator('summary'));check(await folded.evaluate(el=>el.open),'TOUCH_EXPAND');
      await tap(button('計算結果',touch));await touch.getByRole('dialog',{name:'計算結果',exact:true}).waitFor();await tap(button('計算結果を閉じる',touch));
      await state({stale:false});await touch.reload();await touch.locator('.draft-editor').waitFor();await tap(button('シフトを公開',touch));
      const confirmation=touch.getByRole('dialog',{name:'シフトを公開',exact:true});await confirmation.waitFor();await tap(confirmation.getByRole('checkbox'));
      check(!await button('再検証して公開',confirmation).isDisabled(),'TOUCH_ACK');await tap(button('公開確認を閉じる',confirmation));
    } finally { await touchContext.close(); }
    results.push('real touch expands advice, opens/closes results, and confirms shortage in publication modal');
    check(!errors.length,'PAGE_ERRORS_'+errors.join(','));
    return {passed:true,results,widths:[1280,390,320],errors,scope:'built product UI with fictional local API; no real publication, solver or Cloudflare'};
  } catch(error) { throw Error('SCHEDULE_ACTIONS_STEP '+step+' '+error.message); }
}
