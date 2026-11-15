async (page) => {
  const results = [], errors = [];
  const check = (ok, code) => { if (!ok) throw Error(code); };
  const button = name => page.getByRole('button', { name, exact: true });
  const field = name => page.getByLabel(name, { exact: true });
  const bulk = () => page.getByRole('region', { name: '担当区分の条件の一括入力', exact: true });
  const saved = async () => JSON.parse(await page.locator('#saved').innerText());
  const preview = () => button('担当区分一括入力の対象を確認').click();
  async function fillRole(patch = {}) {
    const values = { '開始日': '2026-10-01', '終了日': '2026-10-02', '毎日の開始': '0900', '毎日の終了': '1700', '最低人数': '2', '比率の分子': '1', '比率の分母': '5', ...patch };
    for (const [name, value] of Object.entries(values)) await field('担当区分一括入力 ' + name).fill(value);
    await field('担当区分一括入力 対象範囲').selectOption('null'); await field('担当区分一括入力 担当区分').selectOption('sv');
  }
  async function save(n) {
    await button('すべての需要・予定・担当区分を保存').click();
    await page.waitForFunction(n => JSON.parse(document.querySelector('#saved').textContent).length === n, n);
    return (await saved())[n - 1];
  }
  page.removeAllListeners('dialog'); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto('http://127.0.0.1:8799/?roles'); await page.getByRole('tab',{name:'担当区分の必要人数',exact:true}).click(); await button('期間を指定して担当区分の条件を一括入力').click();
  await fillRole({ '終了日': '2026-10-04' });
  for (const name of ['日曜日', '土曜日']) await bulk().getByRole('checkbox', { name, exact: true }).uncheck();
  await preview(); check((await bulk().innerText()).includes('対象2日：追加1件、上書き0件、保持1件'), 'ROLE_WEEKDAY_COUNTS');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'ROLE_OVERFLOW_' + width);
    const bar = button('担当区分一括入力の対象を確認').locator('..');
    check(await bar.evaluate(e => getComputedStyle(e).gap) === '12px', 'ROLE_BUTTON_GAP');
    await bulk().screenshot({ path: `output/playwright/role-bulk/preview-${width}.png` });
  }
  await button('別画面へ移動').click(); await page.getByRole('alertdialog').waitFor(); await button('編集を続ける').click();
  // Demand and role staging inputs must independently block an incomplete save.
  await page.getByRole('tab',{name:'必要人数',exact:true}).click(); await button('期間を指定して必要人数の一括入力').click();
  for (const [name, value] of [['終了日', '2026-10-01'], ['毎日の開始', '0900'], ['毎日の終了', '0930'], ['直接必要人数', '3']]) await field('一括入力 ' + name).fill(value);
  await field('一括入力 業務').selectOption('phone'); await field('一括入力 既存の枠').selectOption('replace');
  await button('一括入力の対象を確認').click(); await button('一括入力を反映').click();
  await button('すべての需要・予定・担当区分を保存').click();
  await page.getByText('この見出しの一括入力を反映するか、リセットしてから保存してください。', { exact: true }).waitFor();
  check((await saved()).length === 0, 'ROLE_PENDING_LOST_AFTER_DEMAND_APPLY');
  await page.getByRole('tab',{name:'担当区分の必要人数',exact:true}).click();
  await field('操作を無効にする').check(); check(await button('担当区分一括入力を反映').isDisabled() && await field('担当区分一括入力 最低人数').isDisabled(), 'ROLE_DISABLED_BYPASS');
  await field('操作を無効にする').uncheck();
  await button('担当区分一括入力を反映').click(); check((await saved()).length === 0, 'ROLE_APPLY_SAVED_REMOTELY');
  const first = await save(1);
  check(first.roleRequirements.length === 2 && first.roleRequirements[0].minimum === 0 && first.roleRequirements[1].minimum === 2, 'ROLE_KEEP_OR_EXPANSION');
  check(first.roleRequirements[1].ratioNumerator === 1 && first.roleRequirements[1].ratioDenominator === 5 && first.roleRequirements[0].taskId === null, 'ROLE_RATIO_OR_SCOPE');
  check(first.demand[0].direct === 300 && first.demand[0].calculated === 0 && first.events[0].start === 607 && first.events[0].end === 617, 'ROLE_LOST_DEMAND_OR_EVENT');
  results.push({ name: 'period/weekdays, keep existing, counts/ratio, independent staging guards, loss guard, disabled, 3 widths', passed: true });

  await fillRole(); await field('担当区分一括入力 対象範囲').selectOption(JSON.stringify('phone')); await preview();
  check((await bulk().innerText()).includes('対象2日：追加2件、上書き0件、保持0件'), 'ROLE_SCOPE_NOT_DISTINCT');
  await button('担当区分一括入力を反映').click(); const second = await save(2);
  check(second.roleRequirements.length === 4 && second.roleRequirements.filter(r => r.taskId === 'phone').length === 2, 'ROLE_SCOPE_SAVE');
  await fillRole({ '毎日の開始': '1000', '毎日の終了': '1800' }); await preview();
  check((await bulk().innerText()).includes('2026-10-01の0900〜1700の既存条件と時間帯が重なります。'), 'ROLE_PARTIAL_OVERLAP_ACCEPTED');
  check(await button('担当区分一括入力を反映').count() === 0, 'ROLE_CONFLICT_APPLY_VISIBLE');
  await button('担当区分一括入力をリセット').click(); await fillRole({ '比率の分母': '0' }); await preview();
  check((await bulk().innerText()).includes('分母は1〜10000'), 'ROLE_DENOMINATOR_ZERO_ACCEPTED');
  await field('担当区分一括入力 比率の分母').fill('1'); await field('担当区分一括入力 最低人数').fill('0'); await field('担当区分一括入力 比率の分子').fill('0');
  await field('担当区分一括入力 既存の条件').selectOption('replace'); await preview();
  check((await bulk().innerText()).includes('対象2日：追加0件、上書き2件、保持0件'), 'ROLE_REPLACE_COUNTS');
  await field('担当区分の条件 1 最低人数').fill('4'); check(await button('担当区分一括入力を反映').count() === 0, 'ROLE_STALE_ROWS_PREVIEW');
  await field('担当区分の条件 1 最低人数').fill('0'); await preview();
  await field('担当区分一括入力 最低人数').fill('1'); check(await button('担当区分一括入力を反映').count() === 0, 'ROLE_STALE_CONDITIONS_PREVIEW');
  await field('担当区分一括入力 最低人数').fill('0'); await preview(); await button('担当区分一括入力を反映').click();
  const third = await save(3);
  check(third.roleRequirements.filter(r => r.taskId === null).every(r => r.minimum === 0 && r.ratioNumerator === 0 && r.ratioDenominator === 1), 'ROLE_EXPLICIT_ZERO_REPLACE');
  check(JSON.stringify(third.roleRequirements.map(r => r.id)) === JSON.stringify(second.roleRequirements.map(r => r.id)), 'ROLE_IDS_CHANGED');
  check(JSON.stringify(third.roleRequirements.filter(r => r.taskId === 'phone')) === JSON.stringify(second.roleRequirements.filter(r => r.taskId === 'phone')), 'ROLE_OTHER_SCOPE_CHANGED');
  results.push({ name: 'distinct scopes, reject partial overlap/zero denominator, exact replacement, zero counts and identities, stale previews', passed: true });

  await fillRole({ '終了日': '2026-10-31' }); await preview();
  check((await bulk().innerText()).includes('対象31日：追加29件、上書き0件、保持2件'), 'ROLE_MONTH_COUNT');
  await button('担当区分一括入力を反映').click(); const fourth = await save(4);
  check(fourth.roleRequirements.length === 33, 'ROLE_MONTH_SAVE');
  check(JSON.stringify(fourth.demand) === JSON.stringify(first.demand) && JSON.stringify(fourth.events) === JSON.stringify(first.events), 'ROLE_MONTH_CHANGED_OTHER_SECTIONS');
  await button('別画面へ移動').click(); await page.getByText('移動済み', { exact: true }).waitFor();
  check(await page.getByRole('alertdialog').count() === 0 && errors.length === 0, 'ROLE_AFTER_SAVE_STATE');
  results.push({ name: 'whole month 31 daily conditions plus 2 other scope, save clears loss guard', passed: true });
  return { passed: true, results, pageErrors: errors, monthlyRoleRows: 33, cloudflareRequests: 0, backendSave: 'captured local callback' };
}
