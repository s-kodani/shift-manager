// Invoke with scripts/run-ui-refresh-browser.mjs. No live teams or Cloudflare calls.
async (page, owner) => {
  if (!['localhost', '127.0.0.1'].includes(new URL(page.url()).hostname)) throw Error('LOCAL_ONLY');
  const results = [], screenshots = [];
  const check = (condition, code) => { if (!condition) throw Error(code); };
  const button = name => page.getByRole('button', { name, exact: true });
  const capture = async name => { const file = owner.output + '/' + name + '.png'; await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); };
  const layout = async name => {
    const m = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
      padding: [...document.querySelectorAll('[data-slot=card-content]')].map(el => parseFloat(getComputedStyle(el).paddingLeft)),
      fields: [...document.querySelectorAll('.form-grid')].map(el => parseFloat(getComputedStyle(el).rowGap)) }));
    check(m.document <= m.width, 'PAGE_OVERFLOW');
    check(m.padding.every(p => p >= (m.width < 768 ? 16 : 24)), 'CARD_PADDING');
    check(m.fields.every(p => p >= 24), 'FORM_SPACING');
    results.push({ name, ...m });
  };
  if (owner.stage === 'login') {
    await page.getByRole('textbox',{name:'メールアドレス',exact:true}).fill(owner.email);
    await page.getByRole('textbox',{name:'パスワード',exact:true}).fill(owner.password);
    await button('ログイン').click();
    await page.getByRole('heading',{name:'公開済みのシフト',exact:true}).waitFor();
    results.push({name:'fictional administrator sign-in',passed:true});
  } else if (owner.stage === 'admin') {
    for (const width of [1280, 1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['シフト・計算結果', '需要管理', '勤務履歴', '休暇・欠勤', '勤務不可・希望', 'チーム設定', 'スタッフ管理', '企業共通ルール']) {
        await button(name).click();
        const ready = {'需要管理':'月別の需要・予定・担当区分の条件','勤務不可・希望':'このチームの受付再開'}[name];
        if(ready)await page.getByRole('heading',{name:ready,exact:true}).waitFor();
        if(name==='チーム設定')await button('すべてのチーム設定を保存').waitFor();
        if(name==='勤務履歴')await button('確認した履歴を保存').waitFor();
        if(name==='スタッフ管理')await button('勤務契約・習熟度・対応可能な担当をすべて保存').waitFor();
        await page.waitForFunction(() => document.querySelectorAll('[data-slot=loading][aria-busy=true]').length === 0);
        await layout(name + '-' + width);
        await capture('admin-' + width + '-' + ({'シフト・計算結果':'schedule','需要管理':'demand','勤務履歴':'history','休暇・欠勤':'leave','勤務不可・希望':'submission','チーム設定':'team','スタッフ管理':'staff','企業共通ルール':'company'})[name]);
      }
    }
  } else if (owner.stage === 'loading') {
    await page.setViewportSize({ width: 1280, height: 900 });
    let release, entered;
    const delayed = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    await page.route('**/api/context', async route => { entered(); await delayed; await route.continue(); });
    try {
      await page.reload(); await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(Error('CONTEXT_ROUTE_NOT_REACHED')), 15000))]);
      await page.getByText('画面のデータを読み込んでいます…', { exact: true }).waitFor();
      check(await page.getByText('この月はまだ公開されていません。', { exact: true }).count() === 0, 'EMPTY_STATE_DURING_LOAD');
      await capture('loading-context'); release();
      await page.getByText('画面のデータを読み込んでいます…', {exact:true}).waitFor({state:'hidden'});
      await button('チーム設定').waitFor();
    } finally { release(); await page.unroute('**/api/context'); }
    await button('チーム設定').click();
    await button('すべてのチーム設定を保存').waitFor();
    await page.getByRole('combobox', { name: '業務配置枠', exact: true }).focus(); await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => ({ outline: getComputedStyle(document.activeElement).outlineStyle, width: parseFloat(getComputedStyle(document.activeElement).outlineWidth) }));
    check(focus.outline !== 'none' && focus.width >= 2, 'KEYBOARD_FOCUS');
    await page.route('**/contract-options/*', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'INTERNAL_ERROR' }) }));
    try {
      await button('スタッフ管理').click();
      await page.getByText('契約条件を取得できませんでした。最新の入力を読み直してください。', { exact: true }).waitFor();
      check(await page.getByText('契約条件を取得しています…', { exact: true }).count() === 0, 'FAILED_LOAD_STILL_SPINS');
      await page.locator('.toast-item.toast-error').first().waitFor();
      await capture('loading-failure');
    } finally { await page.unroute('**/contract-options/*'); }
    await button('企業共通ルール').click();
    const deadline = page.getByRole('spinbutton', { name: '毎月の希望締切日', exact: true }); await deadline.waitFor();
    await deadline.fill('22');
    await page.getByRole('combobox',{name:'週の開始曜日',exact:true}).selectOption('1');
    await page.getByRole('combobox',{name:'午前・午後の境界時刻',exact:true}).selectOption('720');
    await page.getByRole('combobox',{name:'担当区分人数の端数処理',exact:true}).selectOption('ceil');
    let resumeSave, seenSave;
    const saveGate = new Promise(resolve => { resumeSave = resolve; }), saveReached = new Promise(resolve => { seenSave = resolve; });
    let saves = 0;
    await page.route('**/calendar-settings', async route => { if (route.request().method() === 'POST') { saves++; seenSave(); await saveGate; } await route.continue(); });
    try {
      await button('カレンダー設定を保存').click(); await Promise.race([saveReached, new Promise((_, reject) => setTimeout(() => reject(Error('SAVE_ROUTE_NOT_REACHED')), 15000))]);
      await page.locator('button[aria-busy=true]').waitFor();
      check(await page.locator('button[aria-busy=true] .ui-spinner').count() > 0, 'SAVE_SPINNER_MISSING');
      await capture('loading-save'); resumeSave();
      await page.locator('.toast-item.toast-success').waitFor();
      check(saves === 1, 'DUPLICATE_SAVE');
      const rect = await page.locator('.toast-viewport').evaluate(el => { const r = el.getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom }; });
      check(rect.right >= 15 && rect.right <= 17 && rect.bottom >= 15 && rect.bottom <= 17, 'TOAST_NOT_BOTTOM_RIGHT');
      await capture('toast-success');
    } finally { resumeSave(); await page.unroute('**/calendar-settings'); }
    results.push({ name: 'initial skeleton, request failure, keyboard focus, save spinner, single POST and bottom-right toast', passed: true });
  } else if (owner.stage === 'spacing') {
    await button('スタッフ管理').click();
    await page.getByRole('heading',{name:'勤務契約・習熟度・対応可能な担当',exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('[data-slot=loading]').length===0);
    for(const width of [1280,1440,390,320]){
      await page.setViewportSize({width,height:900});
      const measure = await button('CSVテンプレートを取得').evaluate(b=>{
        const separator=b.closest('.form-actions').nextElementSibling;
        const selects=[...document.querySelectorAll('select.ui-native-select')];
        return {gap:separator.getBoundingClientRect().top-b.getBoundingClientRect().bottom, arrows:selects.map(el=>({paddingRight:parseFloat(getComputedStyle(el).paddingRight),position:getComputedStyle(el).backgroundPosition,appearance:getComputedStyle(el).appearance}))};
      });
      check(measure.gap>=24,'CSV_SEPARATOR_GAP');
      check(measure.arrows.length>0 && measure.arrows.every(a=>a.paddingRight>=40 && a.position.includes('12px') && a.appearance==='none'),'SELECT_ARROW_INSET');
      await layout('spacing-'+width);await capture('spacing-'+width);results.push({width,...measure});
    }
  } else if (owner.stage === 'guards') {
    await page.setViewportSize({ width: 1280, height: 900 });
    await button('企業共通ルール').click();
    const deadline = page.getByRole('spinbutton', { name: '毎月の希望締切日', exact: true }); await deadline.waitFor();
    const original = await deadline.inputValue(); await deadline.fill(original === '21' ? '22' : '21');
    await button('需要管理').click();
    const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
    await capture('confirmation');
    await dialog.getByRole('button', { name: '編集を続ける', exact: true }).click();
    check(await deadline.inputValue() !== original, 'CANCEL_LOST_INPUT');
    await button('需要管理').click(); await dialog.waitFor();
    await dialog.getByRole('button', { name: '変更を破棄して進む', exact: true }).click();
    await page.getByRole('heading', { name: '需要管理', exact: true }).waitFor();
    const dirty = await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; });
    check(!dirty, 'UNMOUNTED_FORM_STAYS_DIRTY');
    results.push({ name: 'real Alert Dialog cancellation/acceptance and unload flags', passed: true });
  } else if (owner.stage === 'staff' || owner.stage === 'staff-views') {
    if(owner.stage==='staff'){
    await button('ログアウト').click();
    await page.getByRole('textbox', { name: 'メールアドレス', exact: true }).fill(owner.staffLogin.email);
    await page.getByRole('textbox', { name: 'パスワード', exact: true }).fill(owner.staffLogin.initialPassword);
    await button('ログイン').click();
    await page.getByRole('heading', { name: '初回パスワードの変更', exact: true }).waitFor();
    await page.getByRole('textbox', { name: '現在のパスワード', exact: true }).fill(owner.staffLogin.initialPassword);
    await page.getByRole('textbox', { name: '新しいパスワード（12〜128文字）', exact: true }).fill('Fictional-staff-ui-refresh-2026!');
    await page.getByRole('textbox', { name: '新しいパスワードをもう一度', exact: true }).fill('Fictional-staff-ui-refresh-2026!');
    await button('変更して利用を開始').click();
    }else { await page.goto('http://localhost:8787/app'); await button('休暇・欠勤').waitFor(); }
    for (const width of [1280, 1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const name of ['シフト・計算結果', '休暇・欠勤', '勤務不可・希望']) {
        await button(name).click();
        await page.waitForFunction(() => document.querySelectorAll('[data-slot=loading][aria-busy=true]').length === 0);
        if(name==='勤務不可・希望')await page.getByRole('heading',{name:'自分の勤務不可・希望',exact:true}).waitFor();
        if(name==='休暇・欠勤')await page.getByRole('heading',{name:'自分の受付履歴',exact:true}).waitFor();
        await page.waitForFunction(()=>document.querySelectorAll('[data-slot=loading]').length===0);
        await layout('staff-' + name + '-' + width);
        await capture('staff-' + width + '-' + ({'シフト・計算結果':'schedule','休暇・欠勤':'leave','勤務不可・希望':'submission'})[name]);
      }
    }
  } else if (owner.stage === 'reset') {
    await page.goto('http://localhost:8787/reset');
    await page.getByText('有効な再設定リンクがありません。メール内のリンクを開き直してください。', { exact: true }).first().waitFor();
    check(await page.locator('input:visible').count() === 0, 'INVALID_RESET_HAS_INPUT');
    for (const width of [1280, 1440, 390, 320]) { await page.setViewportSize({ width, height: 900 }); await layout('reset-' + width); await capture('reset-' + width); }
    await page.goto('http://localhost:8787/reset#token=fictional-ui-reset-token');
    await page.getByRole('textbox', { name: '新しいパスワード', exact: true }).fill('Fictional-reset-ui-2026!');
    await page.getByRole('textbox', { name: '新しいパスワード（確認）', exact: true }).fill('Fictional-reset-ui-2026!');
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; }), hit = new Promise(resolve => { reached = resolve; });
    await page.route('**/api/auth/reset-password', async route => { reached(); await gate; await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' }); });
    try {
      await button('パスワードを変更する').click(); await hit;
      await page.locator('#submit-button[aria-busy=true]').waitFor(); await capture('reset-loading');
      release(); await page.getByText('リンクが無効、期限切れ、または使用済みです。新しい再設定メールを取得してください。', { exact: true }).first().waitFor();
      check(await page.locator('#submit-button[aria-busy=true]').count() === 0, 'RESET_SPINNER_STUCK');
      check(new URL(page.url()).hash === '', 'RESET_TOKEN_STAYS_IN_URL');
      await capture('reset-expired');
    } finally { release(); await page.unroute('**/api/auth/reset-password'); }
    results.push({ name: 'public reset invalid/expired link and in-flight button; response 400 controlled', passed: true });
  }
  return { stage: owner.stage, results, screenshots, cloudflareRequests: 0 };
}
