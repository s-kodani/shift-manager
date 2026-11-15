// Fictional component fixture: no backend writes, deploys, or solver runs.
async (page) => {
  page.setDefaultTimeout(10000);
  let step = 'tabs';
  try {
  const check = (value, code) => { if (!value) throw Error(code); };
  const button = name => page.getByRole('button', {name, exact:true});
  const field = name => page.getByLabel(name, {exact:true});
  const tab = name => page.getByRole('tab', {name, exact:true});
  const dialog = () => page.getByRole('dialog', {name:'需要CSVの取り込み', exact:true});
  const errors = [], screenshots = [], results = [];
  page.removeAllListeners('dialog'); page.on('dialog', value => value.accept());
  page.on('pageerror', error => errors.push(error.message));
  await page.unrouteAll({behavior:'ignoreErrors'});
  let previewFailure = false, stalePreview = false, applyFailure = false, releasePreview, releaseApply;
  let previewGate = null, applyGate = null, applied = 0;
  await page.route('**/demand-csv/preview', async route => {
    if (previewGate) await previewGate;
    if (previewFailure) return route.fulfill({status:409, json:{error:'VERSION_CONFLICT'}});
    await route.fulfill({json:{month:'2026-10', inputRevision:stalePreview ? 1 : 0, csvSha256:'a'.repeat(64), previewSha256:'b'.repeat(64), capacityScale:100, added:1, replaced:0,
      rows:[{line:2, demand:{date:'2026-10-01', start:540, end:570, taskId:'phone', direct:0, calculated:275}, action:'ADD', errors:[]}, {line:3, demand:null, action:null, errors:[{column:'end',code:'CSV_INVALID_TIME'}]}]}});
  });
  await page.route('**/api/fixture/csv-apply', async route => {
    if (applyGate) await applyGate;
    if (applyFailure) return route.fulfill({status:503, json:{error:'SERVICE_UNAVAILABLE'}});
    applied++; await route.fulfill({json:{ok:true}});
  });
  const upload = () => field('需要CSVファイル').setInputFiles({name:'fictional.csv', mimeType:'text/csv', buffer:Buffer.from('date,start,end,task_id,direct,calculated\n2026-10-01,09:00,09:30,phone,0,2.75')});
  await page.goto('http://127.0.0.1:8799/?roles');
  await button('すべての需要・予定・担当区分を保存').waitFor();
  check(await tab('必要人数').getAttribute('aria-selected') === 'true', 'DEFAULT_TAB');
  const demandToggle = button('期間を指定して必要人数の一括入力');
  check(await demandToggle.getAttribute('aria-expanded') === 'false' && !await field('一括入力 毎日の開始').isVisible(), 'DEFAULT_DEMAND_COLLAPSE');
  await demandToggle.press('Enter'); await field('一括入力 毎日の開始').fill('0900');
  await field('一括入力 毎日の終了').fill('1000'); await field('一括入力 直接必要人数').fill('2'); await field('一括入力 業務').selectOption('phone');
  await button('一括入力の対象を確認').click(); await demandToggle.click(); await demandToggle.click();
  check(await button('一括入力を反映').isVisible() && await field('一括入力 毎日の開始').inputValue() === '0900', 'COLLAPSE_LOST_PREVIEW');
  await field('必要人数 絞り込み日付').fill('2026-10-01');
  await tab('担当区分の必要人数').click();
  check(await button('期間を指定して担当区分の条件を一括入力').getAttribute('aria-expanded') === 'false', 'DEFAULT_ROLE_COLLAPSE');
  await button('期間を指定して担当区分の条件を一括入力').click(); await field('担当区分一括入力 毎日の開始').fill('0930');
  await tab('研修・会議').click(); await button('研修・会議を保存').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 1);
  await tab('必要人数').click(); check(await button('一括入力を反映').isVisible(), 'OTHER_SAVE_LOST_PREVIEW');
  check(await field('必要人数 絞り込み日付').inputValue() === '2026-10-01', 'TAB_LOST_FILTER');
  await tab('担当区分の必要人数').click(); check(await field('担当区分一括入力 毎日の開始').inputValue() === '0930', 'OTHER_SAVE_LOST_ROLE');
  await button('担当区分一括入力をリセット').click(); await tab('必要人数').click(); await button('一括入力をリセット').click();
  await field('一括入力 終了日').fill('2026-11-01'); await demandToggle.click(); await tab('研修・会議').click();
  await button('すべての需要・予定・担当区分を保存').click();
  await page.getByRole('tab',{name:'必要人数',exact:true,selected:true}).waitFor();
  await field('一括入力 終了日').waitFor({state:'visible'});
  check(await demandToggle.getAttribute('aria-expanded') === 'true', 'HIDDEN_BULK_ERROR');
  await button('一括入力をリセット').click();
  // Native validation must expose an invalid control in another tab.
  await tab('担当区分の必要人数').click(); await field('担当区分の条件 1 比率の分母').fill('0'); await tab('必要人数').click();
  await button('すべての需要・予定・担当区分を保存').click();
  await page.getByRole('tab',{name:'担当区分の必要人数',exact:true,selected:true}).waitFor();
  check(await tab('担当区分の必要人数').getAttribute('aria-selected') === 'true', 'HIDDEN_NATIVE_ERROR');
  check(await field('担当区分の条件 1 比率の分母').evaluate(el => el === document.activeElement), 'INVALID_FOCUS');
  await field('担当区分の条件 1 比率の分母').fill('1');
  // A domain error (not native validity) must also reveal its tab and row.
  await tab('必要人数').click(); await field('需要 1 終了').fill('1000'); await tab('研修・会議').click();
  await button('すべての需要・予定・担当区分を保存').click();
  await page.getByRole('tab',{name:'必要人数',exact:true,selected:true}).waitFor();
  check(await tab('必要人数').getAttribute('aria-selected') === 'true', 'HIDDEN_DOMAIN_ERROR');
  await field('需要 1 終了').fill('0930'); await button('すべての需要・予定・担当区分を保存').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 2);
  results.push('tabs, collapsed previews, isolated save, native/domain error reveal');

  // Unsaved inputs in any tab still block CSV selection.
  await field('需要 1 直接必要人数（空欄＝未設定）').fill('3'); await button('需要CSVの取り込み').click(); await dialog().waitFor();
  check(await field('需要CSVファイル').isDisabled(), 'DIRTY_CSV_ALLOWED'); await button('需要CSVの取り込みを閉じる').click();
  await button('必要人数を保存').click(); await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 3);
  await button('需要CSVの取り込み').click();
  previewGate = new Promise(resolve => { releasePreview = resolve; }); await upload();
  await button('需要CSVの取り込みを閉じる').waitFor({state:'visible'});
  check(await button('需要CSVの取り込みを閉じる').isDisabled(), 'PREVIEW_CLOSE_ENABLED');
  await page.keyboard.press('Escape'); check(await dialog().isVisible(), 'PREVIEW_ESC_CLOSED'); releasePreview(); previewGate = null;
  await page.getByRole('table', {name:'需要CSVプレビュー',exact:true}).waitFor();
  check((await dialog().innerText()).includes('0 ／ 2.75'), 'CSV_ZERO_PRECISION');
  await page.keyboard.press('Escape'); await dialog().waitFor({state:'hidden'});
  await page.waitForFunction(() => document.activeElement?.textContent === '需要CSVの取り込み');
  check(await button('需要CSVの取り込み').evaluate(el => el === document.activeElement), 'MODAL_RETURN_FOCUS');
  await button('需要CSVの取り込み').click(); check(await page.getByRole('table',{name:'需要CSVプレビュー',exact:true}).isVisible(), 'DISMISS_LOST_PREVIEW');
  for (const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    const rect = await dialog().boundingBox(); check(rect.x >= 0 && rect.x + rect.width <= width, 'MODAL_WIDTH_' + width);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'PAGE_OVERFLOW_' + width);
    const path = `output/playwright/planning-display/csv-${width}.png`; await page.screenshot({path}); screenshots.push(path);
  }
  await button('全件中止').click(); check(await page.getByRole('table',{name:'需要CSVプレビュー'}).count() === 0 && applied === 0, 'ABORT_APPLIED');
  previewFailure = true; await upload(); await dialog().getByRole('alert').waitFor(); check(!await button('正常行だけ反映').count(), 'FAILED_PREVIEW_APPLY');
  previewFailure = false; stalePreview = true; await upload(); await page.getByRole('table',{name:'需要CSVプレビュー'}).waitFor(); check(await button('正常行だけ反映').isDisabled(), 'STALE_PREVIEW_APPLY');
  await button('全件中止').click(); stalePreview = false; await upload(); await page.getByRole('table',{name:'需要CSVプレビュー'}).waitFor();
  applyFailure = true; await button('正常行だけ反映').click(); await dialog().getByRole('alert').waitFor(); check(await page.getByRole('table',{name:'需要CSVプレビュー'}).isVisible(), 'FAILED_APPLY_LOST_PREVIEW');
  applyFailure = false; applyGate = new Promise(resolve => { releaseApply = resolve; }); await button('正常行だけ反映').click();
  check(await button('需要CSVの取り込みを閉じる').isDisabled(), 'APPLY_CLOSE_ENABLED'); await page.keyboard.press('Escape'); check(await dialog().isVisible(), 'APPLY_ESC_CLOSED');
  releaseApply(); applyGate = null; await page.waitForFunction(() => document.querySelector('#csv-applied').textContent !== 'null');
  check(applied === 1, 'APPLY_COUNT'); await button('需要CSVの取り込みを閉じる').click();
  results.push('CSV dirty guard, close/reopen, abort, conflict, errors, retry, pending close lock, focus, responsive');

  // Compare category totals against multiple pages, including a category absent from page 1.
  let changesFailure = false, changeMode = 'both', noticesFailure = false, noticeReads = 0, releaseNotices, noticesGate = null;
  const allChanges = [ ...Array.from({length:52}, (_, i) => ({path:['demand',String(i),'direct'],before:0,after:1,beforeTruncated:false,afterTruncated:false})),
    ...[['sources','published_schedule','team'], ['published','staff:2026-10-01','shift','start'], ['mode']].map(path => ({path,before:'draft',after:'reallocation',beforeTruncated:false,afterTruncated:false})) ];
  await page.route('**/fixture-inputs/**', async route => {
    if (changesFailure) return route.fulfill({status:409,json:{error:'VERSION_CONFLICT'}});
    const rows = changeMode === 'none' ? [] : changeMode === 'input' ? allChanges.slice(0,52) : changeMode === 'publication' ? allChanges.slice(52) : allChanges;
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    await route.fulfill({json:{snapshotId:'11111111-1111-4111-8111-111111111111',month:'2026-10',inputRevision:0,currentRevision:0,sourceDraftRevision:0,currentDraftRevision:0,currentInputStatus:'COMPILED',currentInputError:null,
      changes:rows.slice(offset,offset+50),total:rows.length,totals:{input:changeMode === 'both' || changeMode === 'input' ? 52 : 0,publication:changeMode === 'both' || changeMode === 'publication' ? 3 : 0},offset,nextOffset:offset+50<rows.length?offset+50:null}});
  });
  await page.route('**/fixture-notices/notices', async route => { noticeReads++; if (noticesGate) await noticesGate; await route.fulfill(noticesFailure ? {status:503,json:{error:'SERVICE_UNAVAILABLE'}} : {json:{notices:[],nextCursor:null}}); });
  await page.goto('http://127.0.0.1:8799/?roles&overview'); await page.getByText('合計55件の変更（50件を表示）',{exact:true}).waitFor();
  const inputGroup = () => page.getByRole('region',{name:'入力条件の変更',exact:true});
  const publicationGroup = () => page.getByRole('region',{name:'公開版・公開勤務の変化',exact:true});
  check((await inputGroup().innerText()).includes('52件の変更（50件を表示）'), 'INPUT_TOTAL');
  check((await publicationGroup().innerText()).includes('3件の変更（0件を表示）'), 'PUBLICATION_TOTAL');
  await button('次の50件を確認').click(); await publicationGroup().getByRole('table').waitFor();
  check((await inputGroup().innerText()).includes('52件の変更（52件を表示）') && (await publicationGroup().innerText()).includes('3件の変更（3件を表示）'), 'PAGING_CATEGORIES');
  changesFailure = true; await button('差分を読み直す').click(); await page.getByText('差分を確認できませんでした。入力・固定の最新状態を読み直して再確認してください。',{exact:true}).waitFor();
  check(await inputGroup().count() === 0, 'CONFLICT_LEFT_OLD_PAGE'); changesFailure = false;
  for (const mode of ['input','publication','none']) { changeMode = mode; await button('差分を読み直す').click(); await inputGroup().waitFor();
    await inputGroup().getByText(`${mode === 'input' ? 52 : 0}件の変更（${mode === 'input' ? 50 : 0}件を表示）`,{exact:true}).waitFor();
    await publicationGroup().getByText(`${mode === 'publication' ? 3 : 0}件の変更（${mode === 'publication' ? 3 : 0}件を表示）`,{exact:true}).waitFor();
    check((await inputGroup().innerText()).includes(`${mode === 'input' ? 52 : 0}件の変更`), 'INPUT_MODE_' + mode);
    check((await publicationGroup().innerText()).includes(`${mode === 'publication' ? 3 : 0}件の変更`), 'PUBLICATION_MODE_' + mode);
  }
  const refresh = button('最新のお知らせを読み直す');
  check(await refresh.innerText() === '' && await refresh.getAttribute('title') === '最新のお知らせを読み直す', 'REFRESH_ICON');
  step = 'refresh-initial-ready'; await page.waitForFunction(() => !document.querySelector('.notice-heading button').disabled);
  await refresh.focus(); noticesGate = new Promise(resolve => { releaseNotices = resolve; }); await refresh.press('Enter');
  step = 'refresh-busy'; await page.waitForFunction(() => document.querySelector('.notice-heading button').disabled);
  check(await refresh.isDisabled(), 'REFRESH_NOT_LOCKED'); releaseNotices(); noticesGate = null; await page.waitForFunction(() => !document.querySelector('.notice-heading button').disabled);
  step = 'refresh-failure'; noticesFailure = true; await refresh.click(); await page.getByText('お知らせを取得できませんでした。',{exact:true}).waitFor(); step = 'refresh-retry'; noticesFailure = false; await refresh.click();
  await page.waitForFunction(() => !document.querySelector('.notice-heading button').disabled);
  for (const width of [1280,390,320]) { await page.setViewportSize({width,height:900});
    const heading = await page.getByRole('heading',{name:'自分へのシフトのお知らせ',exact:true}).boundingBox(), icon = await refresh.boundingBox();
    check(icon.x >= heading.x + heading.width && Math.abs(icon.y-heading.y) < 2, 'REFRESH_POSITION_' + width);
    const path = `output/playwright/planning-display/overview-${width}.png`; await page.screenshot({path,fullPage:true}); screenshots.push(path);
  }
  check(noticeReads >= 4 && errors.length === 0, 'BROWSER_ERRORS_' + errors.join(','));
  results.push('input/publication category totals and pagination, zero/one-category modes, conflict clearing, refresh keyboard/retry/position');
  return {passed:true,results,screenshots,pageErrors:errors,backendWrites:0,simulatedCsvApplications:applied,cloudflareRequests:0};
  } catch (error) { throw Error(step + ': ' + error.message); }
}
