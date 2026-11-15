async page => {
  page.setDefaultTimeout(15000);
  page.removeAllListeners('dialog'); page.on('dialog', current => current.accept());
  const origin = 'http://127.0.0.1:8799', output = 'output/playwright/result-cards';
  const check = (value, code) => { if (!value) throw Error(code); };
  const button = (name, target = page) => target.getByRole('button', { name, exact:true });
  const results = page.getByRole('dialog', { name:'計算結果', exact:true });
  const table = name => results.getByRole('table', { name, exact:true });
  const card = name => results.locator('.panel').filter({ has:page.getByRole('heading', { name, exact:true }) });
  const defaults = { role:'company_admin', stale:false, status:'VERIFIED', cycle:0, publicationCycle:0, manual:false, noCandidate:false, noPublication:false,
    candidateStatus:'VERIFIED', candidateViolations:[], candidateHistory:[], jobState:'SUCCEEDED', noAssignments:false, resultFailure:false, solverStatus:'FEASIBLE',
    publishFailure:'', publishDelay:0, snapshotFailure:false, fixedFailure:false, missing:false, readinessFailure:false, certificateFailure:false,
    generalShortage:45000, roleSameShortage:0, writes:[], requests:{} };
  const conditions = [
    { id:'first', date:'2026-10-01', start:540, end:570, taskId:'phone', roleId:'leader', minimum:1, ratioNumerator:0, ratioDenominator:1, rounding:'ceil', priority:'first' },
    { id:'same', date:'2026-10-01', start:600, end:660, taskId:null, roleId:'leader', minimum:1, ratioNumerator:0, ratioDenominator:1, rounding:'ceil', priority:'same' },
  ];
  const stages = [ {name:'roleFirst',status:'OPTIMAL'}, {name:'combined',status:'OPTIMAL'}, {name:'missed',status:'OPTIMAL'}, {name:'surplus',status:'FEASIBLE'} ];
  let sample = {};
  const errors = [], writes = [], checks = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url()); });
  const pattern = /\/api\/.*\/(result|snapshots\/[^/]+)$/;
  await page.route(pattern, async route => {
    const response = await route.fetch(), data = await response.json();
    if (new URL(route.request().url()).pathname.endsWith('/result')) {
      data.result.stages = sample.stages ?? stages;
      Object.assign(data.result.validation, {
        intervals:[{date:'2026-10-01',start:540,end:570,taskId:'phone',shortage:1500}],
        roleRequirements:[{id:'first',shortagePersonMinutes:30},{id:'same',shortagePersonMinutes:0}],
      }, sample.validation);
      if (sample.omitDetails) { delete data.result.validation.intervals; delete data.result.validation.roleRequirements; }
    } else data.input.roleRequirements = sample.conditions ?? conditions;
    await route.fulfill({response,json:data});
  });
  const load = async (data = {}) => {
    sample = data;
    await page.request.post(origin + '/__test/state', {data:{...defaults,...data.state}});
    await page.goto(origin + '/app?month=2026-10'); await page.locator('.draft-editor').waitFor();
    await button('計算結果').click(); await results.waitFor();
  };
  let step = 'cards';
  try {
    await page.setViewportSize({width:1280,height:900}); await load();
    const headings = await results.locator('.panel > h2').allTextContents();
    check(JSON.stringify(headings.slice(0,3)) === JSON.stringify(['不足人数','担当区分の不足','段階別の最適化']), 'CARD_ORDER');
    for (const name of headings.slice(0,3)) check(await card(name).count() === 1, 'DISTINCT_CARD_' + name);
    check(await results.locator('.stats > div').count() === 4, 'SUMMARY_LOST');
    check(JSON.stringify(await table('不足人数').locator('th').allTextContents()) === JSON.stringify(['日付','時間','業務','不足人数']), 'GENERAL_COLUMNS');
    check(JSON.stringify(await table('不足人数').locator('tbody td').allTextContents()) === JSON.stringify(['2026-10-01','09:00〜09:30','電話','1.5']), 'GENERAL_VALUES');
    check(JSON.stringify(await table('担当区分の不足').locator('th').allTextContents()) === JSON.stringify(['日付','時間','業務','担当区分','評価順序','不足量（人分）']), 'ROLE_COLUMNS');
    const rows = table('担当区分の不足').locator('tbody tr');
    check(JSON.stringify(await rows.nth(0).locator('td').allTextContents()) === JSON.stringify(['2026-10-01','09:00〜09:30','電話','leader','先行','30']), 'FIRST_VALUES');
    check(JSON.stringify(await rows.nth(1).locator('td').allTextContents()) === JSON.stringify(['2026-10-01','10:00〜11:00','全業務','leader','同段階','0']), 'SAME_OR_ZERO_LOST');
    check((await card('担当区分の不足').innerText()).includes('1人が30分不足すると30人分'), 'UNIT_EXPLANATION');
    check(JSON.stringify(await results.locator('.optimization-stage h3').allTextContents()) === JSON.stringify(['担当区分先行','一般・同段階担当区分の不足','希望未充足','余剰']), 'STAGE_ORDER');
    check(await results.locator('.optimization-stage[data-status=OPTIMAL] .lucide-circle-check').count() === 3, 'OPTIMAL_CHECKS');
    check((await results.locator('.optimization-stage[data-status=FEASIBLE]').innerText()).includes('有効案あり・最良値は未証明'), 'FEASIBLE_COPY');
    check(await results.locator('.optimization-stage[data-status=FEASIBLE] .lucide-circle-check').count() === 0, 'FALSE_CHECK');
    checks.push('three separate cards in order, summary retained, scaled general shortage, first/same and zero role rows, all-task scope, person-minute units and stage order');

    step = 'layout';
    for (const width of [1280,390,320]) {
      await page.setViewportSize({width,height:900});
      await button('計算結果を閉じる',results).focus();
      await results.locator('.staff-dialog-body').evaluate(async el => {
        el.querySelectorAll('.table-scroll').forEach(region => region.scrollLeft = 0);
        await new Promise(requestAnimationFrame); el.scrollTop = 0;
        await new Promise(requestAnimationFrame);
      });
      await page.screenshot({path:output+'/results-'+width+'.png'});
      await card('担当区分の不足').screenshot({path:output+'/roles-'+width+'.png'});
      await card('段階別の最適化').screenshot({path:output+'/stages-'+width+'.png'});
      check(await results.locator('.optimization-stages').evaluate((el, columns) => getComputedStyle(el).gridTemplateColumns.split(' ').length === columns, width > 700 ? 2 : 1), 'STAGE_COLUMNS_' + width);
      check(await results.evaluate(el => el.scrollWidth <= el.clientWidth && el.querySelector('.staff-dialog-body').scrollWidth <= el.querySelector('.staff-dialog-body').clientWidth), 'MODAL_OVERFLOW_' + width);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'PAGE_OVERFLOW_' + width);
      for (const name of ['不足人数の表','担当区分の不足の表']) {
        const region = results.getByRole('region',{name,exact:true});
        if (width < 700) {
          check(await region.evaluate(el => el.scrollWidth > el.clientWidth), 'NO_TABLE_SCROLL_' + name);
          await region.focus(); await page.keyboard.press('End');
          await region.evaluate(el => el.scrollLeft = el.scrollWidth);
          check(await region.evaluate(el => el.scrollLeft > 0), 'SCROLL_FAILED_' + name);
        }
      }
    }
    checks.push('1280/390/320px: two/one stage columns, contained horizontal tables, keyboard focus, no page/modal overflow and screenshots');

    step = 'states'; await page.setViewportSize({width:1280,height:900});
    await load({stages:['OPTIMAL','FEASIBLE','UNKNOWN','INFEASIBLE','MODEL_INVALID','NOT_RUN','UNRECOGNIZED'].map(status => ({name:status,status}))});
    for (const [status,copy] of [['OPTIMAL','最良値を確認済み'],['FEASIBLE','有効案あり・最良値は未証明'],['UNKNOWN','探索内で案を発見できませんでした'],['INFEASIBLE','解なしを証明'],['MODEL_INVALID','モデルの検査に失敗'],['NOT_RUN','検証未実行'],['UNRECOGNIZED','UNRECOGNIZED']]) {
      const tile = results.locator(`.optimization-stage[data-status=${status}]`);
      check(await tile.locator('p').innerText() === copy, 'STATE_COPY_' + status);
      check(await tile.locator('.lucide-circle-check').count() === (status === 'OPTIMAL' ? 1 : 0), 'CHECK_STATE_' + status);
      check(await tile.locator('svg[aria-hidden=true]').count() === 1, 'ICON_ARIA_' + status);
    }
    await load({validation:{intervals:[],roleRequirements:[]},conditions:[],stages:[],state:{generalShortage:0}});
    check((await table('不足人数').innerText()).includes('不足はありません。'), 'NO_SHORTAGE');
    check((await table('担当区分の不足').innerText()).includes('担当区分の検証対象はありません。'), 'NO_ROLE_TARGET');
    check((await card('段階別の最適化').innerText()).includes('段階別の最適化情報はありません'), 'EMPTY_STAGES');
    await load({omitDetails:true});
    check((await table('不足人数').innerText()).includes('検証データを取得できていません'), 'MISSING_GENERAL');
    check((await table('担当区分の不足').innerText()).includes('検証データを取得できていません'), 'MISSING_ROLES');
    await load({validation:{intervals:[],roleRequirements:[]}});
    check((await table('担当区分の不足').innerText()).includes('検証データを取得できていません'), 'MISSING_EXPECTED_ROWS');
    await load({conditions:[],validation:{intervals:[],roleRequirements:[]},state:{candidateStatus:'NOT_RUN'}});
    check((await table('不足人数').innerText()).includes('検証データを取得できていません'), 'UNVERIFIED_ZERO');
    check((await table('担当区分の不足').innerText()).includes('検証データを取得できていません'), 'UNVERIFIED_ROLE_ZERO');
    await load({conditions:[]});
    check((await table('担当区分の不足').innerText()).includes('条件を特定できません（first）'), 'UNMATCHED_CONDITION');
    check(await table('担当区分の不足').locator('tbody tr').count() === 2, 'UNMATCHED_ROWS_LOST');
    checks.push('all stage states and unknown fallback; verified empty, unverified/missing details, missing condition lookup remain distinct');

    step = 'warnings';
    await load({state:{candidateStatus:'INVALID',candidateViolations:['WORKED_MINUTES'],candidateHistory:['fictional:2026-09-30']}});
    check(await results.locator('.alert').count() === 2, 'WARNINGS_LOST');
    check(await results.locator('.alert').evaluateAll(alerts => alerts.every(el => !el.closest('.panel') && !!(el.compareDocumentPosition(document.querySelector('[aria-label="不足人数"]')) & Node.DOCUMENT_POSITION_FOLLOWING))), 'WARNING_PLACEMENT');
    await load({state:{manual:true}});
    check((await card('段階別の最適化').innerText()).includes('段階別の最適化情報はありません'), 'MANUAL_STAGES');
    check((await results.locator('.stats').innerText()).includes('手動編集案・最適性は未証明'), 'MANUAL_LABEL');
    checks.push('violations/history warnings before and outside cards; manual draft has no invented stages');
    check(!errors.length,'PAGE_ERRORS_' + errors.join(',')); check(!writes.length,'BUSINESS_WRITES_' + writes.join(','));
    await button('計算結果を閉じる',results).click();
    return {passed:true,checks,errors,writes,widths:[1280,390,320],scope:'real built UI with fictional local API; no solver or Cloudflare'};
  } catch(error) { throw Error('RESULT_CARDS_STEP ' + step + ' ' + error.message); }
  finally { await page.unroute(pattern); }
}
