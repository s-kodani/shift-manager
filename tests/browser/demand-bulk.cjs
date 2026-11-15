async (page) => {
  const results = [], errors = [];
  const assert = (ok, code) => { if (!ok) throw Error(code); };
  const button = name => page.getByRole('button', { name, exact: true });
  const field = name => page.getByLabel(name, { exact: true });
  const bulk = () => page.getByRole('region', { name: '需要の一括入力', exact: true });
  const saved = async () => JSON.parse(await page.locator('#saved').innerText());
  const preview = () => button('一括入力の対象を確認').click();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8799');
  await button('すべての需要・予定・担当区分を保存').waitFor();
  await button('期間を指定して必要人数の一括入力').click();
  for (const [name, value] of [['終了日', '2026-10-04'], ['毎日の開始', '0900'], ['毎日の終了', '1000'], ['直接必要人数', '0']])
    await field('一括入力 ' + name).fill(value);
  await field('一括入力 業務').selectOption('phone');
  await preview();
  assert((await bulk().innerText()).includes('対象4日・8枠：追加7件、上書き0件、保持1件'), 'INCLUSIVE_PREVIEW');
  await button('すべての需要・予定・担当区分を保存').click();
  await page.getByText('この見出しの一括入力を反映するか、リセットしてから保存してください。', { exact: true }).waitFor();
  assert((await saved()).length === 0, 'UNAPPLIED_SAVED');
  await button('別画面へ移動').click();
  await page.getByRole('alertdialog').waitFor();
  await button('編集を続ける').click();
  await field('一括入力 直接必要人数').fill('2');
  assert(await button('一括入力を反映').count() === 0, 'STALE_INPUT_PREVIEW');
  await field('一括入力 直接必要人数').fill('0');
  await bulk().getByRole('checkbox', { name: '日曜日', exact: true }).uncheck();
  await bulk().getByRole('checkbox', { name: '土曜日', exact: true }).uncheck();
  await preview();
  assert((await bulk().innerText()).includes('対象2日・4枠：追加3件、上書き0件、保持1件'), 'WEEKDAYS_PREVIEW');
  // A manual edit invalidates a prepared preview without overwriting that edit.
  await field('需要 1 直接必要人数（空欄＝未設定）').fill('1');
  assert(await button('一括入力を反映').count() === 0, 'STALE_ROWS_PREVIEW');
  await field('需要 1 直接必要人数（空欄＝未設定）').fill('');
  await preview(); await button('一括入力を反映').click();
  assert((await saved()).length === 0, 'APPLY_PERSISTED_WITHOUT_SAVE');
  await button('すべての需要・予定・担当区分を保存').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 1);
  const first = (await saved())[0];
  assert(first.demand.length === 4 && first.demand[0].direct === null && first.demand[0].calculated === 0, 'KEEP_REFERENCE_ZERO');
  assert(first.demand.slice(1).every(r => r.direct === 0 && r.calculated === null), 'NEW_ZERO_NOT_UNSET');
  assert(first.events[0].start === 607 && first.events[0].end === 617, 'EVENT_CHANGED');
  results.push({ name: 'inclusive dates/weekdays, preview invalidation, pending save/loss guard, keep calculated0, save explicit0', passed: true });
  for (const [name, value] of [['終了日', '2026-10-02'], ['毎日の開始', '0900'], ['毎日の終了', '1000'], ['直接必要人数', '0.29']])
    await field('一括入力 ' + name).fill(value);
  await field('一括入力 業務').selectOption('phone');
  await field('一括入力 既存の枠').selectOption('replace');
  await preview();
  assert((await bulk().innerText()).includes('対象2日・4枠：追加0件、上書き4件、保持0件'), 'REPLACE_PREVIEW');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'OVERFLOW_' + width);
    await bulk().screenshot({ path: `output/playwright/demand-bulk/preview-${width}.png` });
  }
  await field('操作を無効にする').check();
  assert(await button('一括入力を反映').isDisabled() && await field('一括入力 開始日').isDisabled(), 'DISABLED_BYPASS');
  await field('操作を無効にする').uncheck();
  await button('一括入力を反映').click(); await button('すべての需要・予定・担当区分を保存').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 2);
  const second = (await saved())[1];
  assert(second.demand.every(r => r.direct === 29) && second.demand[0].calculated === 0, 'REPLACE_REFERENCE_LOST');
  assert(JSON.stringify(second.events) === JSON.stringify(first.events), 'REPLACE_EVENTS_CHANGED');
  results.push({ name: 'replace direct demand exactly, preserve calculated/events, disabled controls, no overflow at1280/390/320', passed: true });
  await field('一括入力 毎日の開始').fill('0931'); await field('一括入力 毎日の終了').fill('1000');
  await preview();
  assert((await bulk().innerText()).includes('開始・終了をチームの配置枠に合わせてください。'), 'MISALIGNED_ACCEPTED');
  await button('一括入力をリセット').click();
  for (const [name, value] of [['毎日の開始', '0900'], ['毎日の終了', '1700'], ['直接必要人数', '3']])
    await field('一括入力 ' + name).fill(value);
  await field('一括入力 業務').selectOption('phone');
  await preview();
  assert((await bulk().innerText()).includes('対象31日・496枠：追加492件、上書き0件、保持4件'), 'MONTH_PREVIEW');
  await button('一括入力を反映').click();
  await page.getByRole('table', { name: '必要人数一覧', exact: true }).waitFor();
  assert(await page.getByRole('table', { name: '必要人数一覧', exact: true }).locator('tbody tr').count() === 25, 'MONTH_PAGE_SIZE');
  await button('すべての需要・予定・担当区分を保存').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 3);
  assert((await saved())[2].demand.length === 496, 'HIDDEN_ROWS_NOT_SAVED');
  await button('別画面へ移動').click();
  await page.getByText('移動済み', { exact: true }).waitFor();
  assert(await page.getByRole('alertdialog').count() === 0, 'DIRTY_AFTER_SAVE');
  assert(errors.length === 0, 'PAGE_ERRORS');
  results.push({ name: 'reject misaligned times, month496 slots saved including undisplayed rows, save clears loss guard', passed: true });
  return { passed: true, results, pageErrors: errors, monthlyDemandRows: 496, cloudflareRequests: 0, backendSave: 'captured local callback' };
}
