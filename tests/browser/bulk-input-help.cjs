// Run against scripts/serve-demand-bulk-verification.mjs; all data is fictional.
async (page) => {
  const assert = (ok, code) => { if (!ok) throw Error(code); };
  const definitions = [
    { region: '需要の一括入力', heading: '期間を指定して必要人数の一括入力', prefix: '一括入力 ',
      fields: ['開始日', '終了日', '毎日の開始', '毎日の終了', '業務', '直接必要人数', '既存の枠', '対象曜日'] },
    { region: '担当区分の条件の一括入力', heading: '期間を指定して担当区分の条件を一括入力', prefix: '担当区分一括入力 ',
      fields: ['開始日', '終了日', '毎日の開始', '毎日の終了', '対象範囲', '担当区分', '最低人数', '比率の分子', '比率の分母', '既存の条件', '対象曜日'] },
  ];
  const errors = [], results = [], screenshots = [];
  const state = target => target.locator('input,select').evaluateAll(elements => elements.map(el => ({ value: el.value, checked: el.checked })));
  const button = (target, name) => target.getByRole('button', { name, exact: true });
  const help = (target, title) => button(target, title + 'の説明');
  const dialog = (target, title) => target.getByRole('dialog', { name: title, exact: true });
  const browser = page.context().browser();
  for (const mode of [{ width: 1280 }, { width: 320 }, { width: 390, touch: true }]) {
    const context = await browser.newContext({ viewport: { width: mode.width, height: 900 }, hasTouch: !!mode.touch, isMobile: !!mode.touch });
    try {
      const target = await context.newPage();
      target.on('pageerror', e => errors.push(e.message));
      await target.goto('http://127.0.0.1:8799/?roles');
      await button(target, 'すべての需要・予定・担当区分を保存').waitFor();
      const before = JSON.stringify(await state(target));
      for (const definition of definitions) {
        await target.getByRole('tab',{name:definition.prefix.startsWith('担当区分')?'担当区分の必要人数':'必要人数',exact:true}).click();
        await button(target,definition.heading).click();
        const region = target.getByRole('region', { name: definition.region, exact: true });
        const titles = [definition.heading, ...definition.fields.map(field => definition.prefix + field)];
        for (const title of titles) {
          const trigger = help(region, title);
          assert(await trigger.count() === 1, 'HELP_MISSING_' + title);
          if (mode.touch) await trigger.tap(); else await trigger.click();
          const popup = dialog(target, title);
          await popup.waitFor();
          assert((await popup.locator('p').innerText()).length > 20, 'EMPTY_HELP_' + title);
          const rect = await popup.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
          assert(rect.left >= 7 && rect.right <= mode.width - 7 && rect.top >= 7 && rect.bottom <= 893, 'POPUP_OVERFLOW_' + title);
          assert(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'PAGE_OVERFLOW');
          if (title.endsWith('対象曜日')) {
            const file = `output/playwright/bulk-input-help/${definition.prefix.trim()}-${mode.width}.png`;
            await target.screenshot({ path: file }); screenshots.push(file);
          }
          if (mode.touch) await button(target, '説明を閉じる').tap(); else await button(target, '説明を閉じる').click();
          await popup.waitFor({ state: 'detached' });
        }
        // Keyboard access and Escape retain focus on the icon.
        if (!mode.touch) {
          const trigger = help(region, definition.heading);
          await trigger.focus(); await trigger.press('Enter');
          await dialog(target, definition.heading).waitFor(); await trigger.press('Escape');
          await dialog(target, definition.heading).waitFor({ state: 'detached' });
          assert(await trigger.evaluate(el => el === document.activeElement), 'FOCUS_NOT_RESTORED');
          await trigger.press('Space'); await dialog(target, definition.heading).waitFor();
          await button(target, '説明を閉じる').click();
        }
      }
      assert(JSON.stringify(await state(target)) === before, 'HELP_CHANGED_INPUTS');
      assert(await target.locator('#saved').innerText() === '[]', 'HELP_SAVED');
      await button(target, '別画面へ移動').click(); await target.getByText('移動済み', { exact: true }).waitFor();
      assert(await target.getByRole('alertdialog').count() === 0, 'HELP_MARKED_DIRTY');
      await target.reload();
      // Help must preserve a populated form and both prepared previews.
      for (const [label, value] of [['一括入力 毎日の開始', '0900'], ['一括入力 毎日の終了', '1000'], ['一括入力 直接必要人数', '2'],
        ['担当区分一括入力 毎日の開始', '0900'], ['担当区分一括入力 毎日の終了', '1700'],
        ['担当区分一括入力 最低人数', '1'], ['担当区分一括入力 比率の分子', '0'], ['担当区分一括入力 比率の分母', '1']])
        { const role = label.startsWith('担当区分'); await target.getByRole('tab',{name:role?'担当区分の必要人数':'必要人数',exact:true}).click();const toggle = button(target,role?definitions[1].heading:definitions[0].heading);if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();await target.getByLabel(label, { exact: true }).fill(value); }
      await target.getByRole('tab',{name:'必要人数',exact:true}).click();
      await target.getByLabel('一括入力 業務', { exact: true }).selectOption('phone');
      await button(target, '一括入力の対象を確認').click();
      await target.getByRole('tab',{name:'担当区分の必要人数',exact:true}).click();
      await target.getByLabel('担当区分一括入力 対象範囲', { exact: true }).selectOption('null');
      await target.getByLabel('担当区分一括入力 担当区分', { exact: true }).selectOption('sv');
      await button(target, '担当区分一括入力の対象を確認').click();
      const edited = JSON.stringify(await state(target));
      for (const definition of definitions) {
        await target.getByRole('tab',{name:definition.prefix.startsWith('担当区分')?'担当区分の必要人数':'必要人数',exact:true}).click();
        await help(target, definition.prefix + '対象曜日').click();
        await dialog(target, definition.prefix + '対象曜日').waitFor();
        await button(target, '説明を閉じる').click();
      }
      assert(JSON.stringify(await state(target)) === edited, 'HELP_CHANGED_EDITED_INPUTS');
      assert(await button(target, '担当区分一括入力を反映').isEnabled(), 'ROLE_HELP_INVALIDATED_PREVIEW');await target.getByRole('tab',{name:'必要人数',exact:true}).click();assert(await button(target, '一括入力を反映').isEnabled(), 'HELP_INVALIDATED_PREVIEW');
      for (const definition of definitions) {
        await target.getByRole('tab',{name:definition.prefix.startsWith('担当区分')?'担当区分の必要人数':'必要人数',exact:true}).click();
        await target.getByLabel('操作を無効にする', { exact: true }).check();
        await help(target, definition.heading).click(); await dialog(target, definition.heading).waitFor();
        await button(target, '説明を閉じる').click();
        await target.getByLabel('操作を無効にする', { exact: true }).uncheck();
      }
      await button(target, '別画面へ移動').click(); await target.getByRole('alertdialog').waitFor();
      await button(target, '編集を続ける').click();
      assert(await target.locator('#saved').innerText() === '[]', 'HELP_SUBMITTED_FORM');
      results.push({ width: mode.width, touch: !!mode.touch, helpItems: 21, passed: true });
    } finally { await context.close(); }
  }
  assert(errors.length === 0, 'PAGE_ERRORS_' + errors.join(','));
  return { passed: true, results, screenshots, pageErrors: errors, cloudflareRequests: 0 };
}
