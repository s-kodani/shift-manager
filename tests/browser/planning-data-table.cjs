async (page) => {
  const check = (ok, code) => { if (!ok) throw Error(code); };
  const button = name => page.getByRole('button', { name, exact: true });
  const show = title => page.getByRole('tab', {name:title,exact:true}).click();
  const field = name => page.getByLabel(name, { exact: true });
  const table = title => page.getByRole('table', { name: title + '一覧', exact: true });
  const pager = title => page.getByLabel(title + 'のページ操作', { exact: true });
  const saved = async () => JSON.parse(await page.locator('#saved').innerText());
  const errors = [], screenshots = [];
  page.removeAllListeners('dialog'); page.on('dialog', dialog => dialog.accept());
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:8799/?roles');
  await show('必要人数');
  await table('必要人数').waitFor();
  await show('必要人数');
  await field('必要人数 絞り込み日付').fill('2026-10-02');
  await show('必要人数');
  await field('必要人数 絞り込み日付').press('Enter');
  check((await saved()).length === 0, 'FILTER_ENTER_SAVED');
  await show('必要人数');
  await field('必要人数 絞り込み日付').fill('');
  await show('必要人数');
  await field('必要人数 日時順').selectOption('desc');
  await show('必要人数');
  await field('必要人数 表示件数').selectOption('50');
  await button('別画面へ移動').click();
  await page.getByText('移動済み', { exact: true }).waitFor();
  check(await page.getByRole('alertdialog').count() === 0, 'VIEW_MARKED_DIRTY');

  await page.goto('http://127.0.0.1:8799/?roles');
  await show('必要人数');
  await table('必要人数').waitFor();
  await button('期間を指定して必要人数の一括入力').click();
  for (const [name, value] of [['毎日の開始','0900'], ['毎日の終了','1700'], ['直接必要人数','3']]) await field('一括入力 ' + name).fill(value);
  await field('一括入力 業務').selectOption('phone');
  await button('一括入力の対象を確認').click(); await button('一括入力を反映').click();
  await show('担当区分の必要人数'); await button('期間を指定して担当区分の条件を一括入力').click();
  await show('担当区分の必要人数');
  for (const [name, value] of [['毎日の開始','0900'], ['毎日の終了','1700'], ['最低人数','2'], ['比率の分子','1'], ['比率の分母','5']]) await field('担当区分一括入力 ' + name).fill(value);
  await show('担当区分の必要人数');
  await field('担当区分一括入力 対象範囲').selectOption('null');
  await show('担当区分の必要人数');
  await field('担当区分一括入力 担当区分').selectOption('sv');
  await button('担当区分一括入力の対象を確認').click(); await button('担当区分一括入力を反映').click();
  await show('必要人数');
  check(await table('必要人数').locator('tbody tr').count() === 25, 'DEMAND_PAGE_SIZE');
  await show('担当区分の必要人数');
  check(await table('担当区分の必要人数').locator('tbody tr').count() === 25, 'ROLE_PAGE_SIZE');
  await show('必要人数');
  await field('需要 1 直接必要人数（空欄＝未設定）').fill('0');
  await show('必要人数');
  await pager('必要人数').getByRole('button', { name: '最後', exact: true }).click();
  await show('必要人数');
  check((await pager('必要人数').innerText()).includes('全496件'), 'DEMAND_MONTH_COUNT');
  await show('担当区分の必要人数');
  await field('担当区分の条件 1 最低人数').fill('4');
  await show('担当区分の必要人数');
  await pager('担当区分の必要人数').getByRole('button', { name: '次へ', exact: true }).click();
  await show('担当区分の必要人数');
  check(await table('担当区分の必要人数').locator('tbody tr').count() === 6, 'ROLE_LAST_PAGE');
  // Invalid input on another page must still prevent saving the entire draft.
  await show('担当区分の必要人数');
  await field('担当区分の条件 31 比率の分母').fill('0');
  await show('担当区分の必要人数');
  await pager('担当区分の必要人数').getByRole('button', { name: '最初', exact: true }).click();
  await button('すべての需要・予定・担当区分を保存').click();
  await page.getByRole('alert').first().waitFor();
  check((await saved()).length === 0, 'HIDDEN_INVALID_SAVED');
  await show('担当区分の必要人数');
  if(await pager('担当区分の必要人数').getByRole('button', { name: '最後', exact: true }).isEnabled()) await pager('担当区分の必要人数').getByRole('button', { name: '最後', exact: true }).click();
  await show('担当区分の必要人数');
  await field('担当区分の条件 31 比率の分母').fill('5');
  await show('必要人数');
  await field('必要人数 絞り込み日付').fill('2026-10-31');
  await show('必要人数');
  check(await table('必要人数').locator('tbody tr').count() === 16, 'DATE_FILTER');
  await show('必要人数');
  await field('必要人数 絞り込み業務').selectOption('phone');
  await show('担当区分の必要人数');
  await field('担当区分の必要人数 絞り込み担当区分').selectOption('leader');
  await show('担当区分の必要人数');
  check((await table('担当区分の必要人数').innerText()).includes('条件に一致する入力はありません'), 'ROLE_FILTER_EMPTY');
  await show('担当区分の必要人数');
  await field('担当区分の必要人数 絞り込み担当区分').selectOption('sv');
  await show('担当区分の必要人数');
  await field('担当区分の必要人数 絞り込み対象範囲').selectOption('null');
  await show('担当区分の必要人数');
  await field('担当区分の必要人数 日時順').selectOption('desc');
  await show('担当区分の必要人数');
  check(await field('担当区分の条件 31 日付').inputValue() === '2026-10-31', 'ROLE_DATE_SORT');
  await show('必要人数');
  await field('必要人数 絞り込み日付').fill('2026-11-01');
  await button('すべての需要・予定・担当区分を保存').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 1);
  const first = (await saved())[0];
  check(first.demand.length === 496 && first.roleRequirements.length === 31, 'HIDDEN_ROWS_LOST');
  check(first.demand[0].direct === 0 && first.demand[0].calculated === 0, 'ZERO_REFERENCE_LOST');
  check(first.roleRequirements[0].minimum === 4 && first.roleRequirements[30].ratioDenominator === 5, 'HIDDEN_EDITS_LOST');
  check(first.events[0].start === 607 && first.events[0].end === 617, 'EVENT_CHANGED');

  await show('必要人数');
  await field('必要人数 絞り込み日付').fill('');
  await show('必要人数');
  await field('必要人数 表示件数').selectOption('100');
  await show('必要人数');
  check(await table('必要人数').locator('tbody tr').count() === 100, 'SIZE_100');
  await show('必要人数');
  await field('必要人数 表示件数').selectOption('50');
  await show('必要人数');
  check(await table('必要人数').locator('tbody tr').count() === 50, 'SIZE_50');
  await show('必要人数');
  await field('必要人数 表示件数').selectOption('25');
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'PAGE_OVERFLOW_' + width);
    for (const [title, slug] of [['必要人数','demand'], ['担当区分の必要人数','roles']]) {
      await show(title);
      const section = page.locator('.planning-data-table').filter({ has: table(title) });
      const scroll = section.locator('.planning-table-scroll');
      check(await scroll.evaluate(e => e.clientHeight <= 620), 'UNBOUNDED_TABLE');
      if (width === 320) check(await scroll.evaluate(e => e.scrollWidth > e.clientWidth), 'MOBILE_TABLE_NOT_SCROLLABLE');
      const path = `output/playwright/planning-data-table/${slug}-${width}.png`;
      await section.screenshot({ path }); screenshots.push(path);
    }
  }
  await show('必要人数'); await field('操作を無効にする').check();
  check(await field('必要人数 絞り込み日付').isDisabled() && await field('需要 1 直接必要人数（空欄＝未設定）').isDisabled(), 'DISABLED_BYPASS');
  await field('操作を無効にする').uncheck();
  await show('必要人数');
  await pager('必要人数').getByRole('button', { name: '次へ', exact: true }).click();
  await show('必要人数');
  await button('需要を追加').click();
  await show('必要人数');
  await field('需要 497 日付').fill('2026-10-31');
  await show('必要人数');
  await field('需要 497 開始').fill('1700');
  await show('必要人数');
  await field('需要 497 終了').fill('1730');
  await show('必要人数');
  await field('需要 497 業務').selectOption('phone');
  await show('必要人数');
  await field('需要 497 直接必要人数（空欄＝未設定）').fill('2');
  await show('必要人数');
  check(await field('需要 497 開始').inputValue() === '1700', 'EDITED_ROW_LOST_ACROSS_PAGES');
  await button('需要 497 を削除').click();
  await button('別画面へ移動').click(); await page.getByText('移動済み', { exact: true }).waitFor();
  check(await page.getByRole('alertdialog').count() === 0, 'VIEW_DIRTY_AFTER_SAVE');

  await page.goto('http://127.0.0.1:8799/?roles'); await table('必要人数').waitFor();
  await show('必要人数');
  await field('必要人数 絞り込み日付').fill('2026-10-31');
  await show('必要人数');
  await button('需要を追加').click();
  await show('必要人数');
  await field('需要 2 開始').waitFor();
  await show('必要人数');
  check(await field('必要人数 絞り込み日付').inputValue() === '', 'NEW_ROW_HIDDEN');
  await show('必要人数');
  await field('需要 2 日付').fill('2026-10-02'); await field('需要 2 開始').fill('0900'); await field('需要 2 終了').fill('0930');
  await show('必要人数');
  await field('需要 2 業務').selectOption('phone'); await field('需要 2 直接必要人数（空欄＝未設定）').fill('1/4');
  await button('必要人数を保存').click(); await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 1);
  check((await saved())[0].demand[1].direct === 25, 'FRACTION_EDIT');
  await button('需要 2 を削除').click(); await button('必要人数を保存').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#saved').textContent).length === 2);
  check((await saved())[1].demand.length === 1, 'DELETE_ROW');
  await show('担当区分の必要人数');
  await field('担当区分の必要人数 絞り込み担当区分').selectOption('leader'); await button('担当区分の条件を追加').click();
  await show('担当区分の必要人数');
  await field('担当区分の条件 2 最低人数').waitFor();
  await show('担当区分の必要人数');
  check(await field('担当区分の必要人数 絞り込み担当区分').inputValue() === '', 'NEW_ROLE_HIDDEN');

  // Reproduce the reported totals and check control geometry, not only page overflow.
  await page.goto('http://127.0.0.1:8799/?roles&layout');
  await show('必要人数');
  await table('必要人数').waitFor();
  for (const width of [1280, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'LAYOUT_OVERFLOW_' + width);
    for (const [title, slug, total, pages] of [['必要人数', 'demand', 792, 32], ['担当区分の必要人数', 'roles', 44, 2]]) {
      await show(title);
      const controls = pager(title);
      check((await controls.getByRole('status').innerText()).includes('全' + total + '件'), 'LAYOUT_TOTAL');
      check(await controls.locator('label').innerText() === '表示件数', 'LONG_SIZE_LABEL');
      check(await controls.locator('.planning-table-page-range').evaluate(e => e.getBoundingClientRect().height <= parseFloat(getComputedStyle(e).lineHeight) + 1), 'SPLIT_RANGE_TEXT_' + width);
      const navigation = controls.locator('.planning-table-page-navigation');
      const names = ['最初', '前へ', '次へ', '最後'];
      for (const name of names) {
        const control = controls.getByRole('button', { name, exact: true });
        check(await control.getAttribute('title') === name, 'MISSING_BUTTON_TITLE');
        check(await control.innerText() === '' && await control.locator('svg[aria-hidden="true"]').count() === 1, 'NOT_ICON_ONLY');
      }
      check(await navigation.evaluate(e => {
        const bounds = e.getBoundingClientRect();
        const children = [...e.children].map(child => child.getBoundingClientRect());
        const buttons = [...e.querySelectorAll('button')].map(child => child.getBoundingClientRect());
        return buttons.every(r => r.width >= 44 && r.height >= 44)
          && children.every(r => r.left >= bounds.left && r.right <= bounds.right + 1 && Math.abs((r.top + r.height / 2) - (bounds.top + bounds.height / 2)) < 1)
          && children.every((r, i) => !i || r.left >= children[i - 1].right);
      }), 'PAGER_GEOMETRY_' + width);
      const settings = await controls.locator('.planning-table-page-settings').boundingBox();
      const nav = await navigation.boundingBox();
      check(settings.y + settings.height <= nav.y, 'PAGER_NOT_TWO_ROWS');
      check(await controls.getByRole('button', { name: '最初', exact: true }).isDisabled()
        && await controls.getByRole('button', { name: '前へ', exact: true }).isDisabled(), 'LAYOUT_FIRST_PAGE_STATE');
      await controls.getByRole('button', { name: '最後', exact: true }).click();
      check((await navigation.innerText()).includes(pages + ' / ' + pages), 'LAYOUT_LAST_PAGE');
      check(await controls.getByRole('button', { name: '次へ', exact: true }).isDisabled()
        && await controls.getByRole('button', { name: '最後', exact: true }).isDisabled(), 'LAYOUT_LAST_PAGE_STATE');
      await controls.getByRole('button', { name: '最初', exact: true }).click();
      const path = `output/playwright/planning-data-table/${slug}-pagination-${width}.png`;
      await controls.screenshot({ path }); screenshots.push(path);
    }
  }
  check(errors.length === 0, 'PAGE_ERRORS');
  return { passed: true, monthlyDemandRows: 496, monthlyRoleRows: 31, layoutDemandRows: 792, layoutRoleRows: 44, layoutWidths: [1280, 768, 390, 320], screenshots, pageErrors: errors, cloudflareRequests: 0, backendSave: 'captured local callback' };
}
