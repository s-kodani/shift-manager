// Run with Playwright CLI against a logged-in, fictional local fixture only.
async (page) => {
  if (new URL(page.url()).hostname !== 'localhost') throw Error('LOCAL_ONLY');
  const results = [], dialogs = [], posts = [];
  let decision = 'dismiss';
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const record = name => results.push({ name, passed: true });
  const onRequest = request => {
    if (request.method() === 'POST' && request.url().endsWith('/calendar-settings'))
      posts.push({ operationId: request.postDataJSON().operationId });
  };
  page.on('request', onRequest);
  const settleDialog = async () => {
    const dialog = page.getByRole('alertdialog');
    const visible = await dialog.waitFor({state:'visible',timeout:500}).then(()=>true,()=>false);
    if(visible){
      dialogs.push({type:'confirm',message:await dialog.innerText()});
      await dialog.getByRole('button',{name:decision==='accept'?'変更を破棄して進む':'編集を続ける',exact:true}).click();
      await dialog.waitFor({state:'hidden'});
    }else if(await page.getByRole('button',{name:'同じ操作を確認',exact:true}).count() && await page.locator('.toast-warning').filter({hasText:'処理中、または応答が未確認の操作があります。'}).count()){
      dialogs.push({type:'alert',message:'pending operation toast'});
    }
  };
  const click = async name => { await page.getByRole('button', { name, exact: true }).click(); await settleDialog(); };
  const heading = name => page.getByRole('heading', { name, exact: true });
  const deadline = () => page.getByRole('spinbutton', { name: '毎月の希望締切日', exact: true });
  const unloadFlag = () => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event); return event.defaultPrevented;
  });
  try {
    assert(!await unloadFlag(), 'CLEAN_PAGE_HAS_UNLOAD_WARNING');
    await click('企業共通ルール'); await deadline().waitFor();
    assert(dialogs.length === 0, 'CLEAN_NAVIGATION_PROMPTED');
    record('clean navigation and unload are unguarded');
    await deadline().fill('21');
    await click('企業共通ルール');
    assert(dialogs.length === 0, 'SAME_SECTION_PROMPTED');
    await click('需要管理');
    assert(await heading('企業共通ルール').count() === 1 && await deadline().inputValue() === '21', 'DISMISSED_SECTION_LOST_INPUT');
    assert(dialogs.at(-1).type === 'confirm', 'MISSING_SECTION_CONFIRM');
    record('cancel section navigation retains input; same section is a no-op');
    const month = page.getByRole('textbox', { name: '対象月', exact: true });
    await month.fill('2026-11'); await settleDialog();
    assert(await month.inputValue() === '2026-10' && await deadline().inputValue() === '21', 'DISMISSED_MONTH_LOST_SCOPE');
    await click('ログアウト');
    assert(await heading('企業共通ルール').count() === 1, 'DISMISSED_LOGOUT_LOST_SESSION');
    assert(await unloadFlag(), 'DIRTY_PAGE_HAS_NO_UNLOAD_WARNING');
    record('month and logout cancellation retain scope/session; synthetic unload is guarded');
    await page.getByRole('textbox', { name: '新しいチーム名', exact: true }).fill('架空の未保存チーム');
    const count = posts.length;
    await click('カレンダー設定を保存');
    assert(posts.length === count && await deadline().inputValue() === '21', 'DISMISSED_MULTI_FORM_SAVE_SENT_REQUEST');
    record('saving one form cannot silently discard another; cancellation sends no POST');
    decision = 'accept'; await click('需要管理');
    await heading('需要管理').waitFor();
    assert(!await unloadFlag(), 'UNMOUNTED_FORMS_REMAIN_DIRTY');
    record('accepted navigation discards forms and clears their flags');
    await click('企業共通ルール'); await deadline().waitFor();
    const calendarRoute = '**/api/companies/*/calendar-settings';
    await page.route(calendarRoute, route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'VERSION_CONFLICT' }) }));
    await deadline().fill('22');
    const refused = page.waitForResponse(response => response.url().endsWith('/calendar-settings') && response.status() === 409);
    const beforeOwnSave = dialogs.length;
    await click('カレンダー設定を保存'); await refused;
    assert(dialogs.length === beforeOwnSave, 'OWN_FORM_SAVE_PROMPTED_TWICE');
    await page.getByRole('button', { name: '最新の入力を読み直す（未保存の入力は破棄）', exact: true }).waitFor();
    decision = 'dismiss'; await click('需要管理');
    assert(await deadline().inputValue() === '22' && await unloadFlag(), 'REFUSED_SAVE_LOST_DIRTY_INPUT');
    record('injected 409 retains input and navigation protection');
    await page.unroute(calendarRoute);
    await page.route(calendarRoute, route => route.abort('failed'));
    await click('カレンダー設定を保存');
    await page.getByText('応答が不明な操作があります。', { exact: false }).waitFor();
    const unknownId = posts.at(-1).operationId, before = dialogs.length;
    decision = 'accept'; await click('需要管理');
    assert(dialogs.length === before + 1 && dialogs.at(-1).type === 'alert', 'UNCERTAIN_OPERATION_CAN_BE_DISCARDED');
    assert(await heading('企業共通ルール').count() === 1 && await deadline().inputValue() === '22', 'UNCERTAIN_OPERATION_LOST_FORM');
    await page.unroute(calendarRoute);
    const saved = page.waitForResponse(response => response.url().endsWith('/calendar-settings') && response.status() === 200);
    await click('同じ操作を確認'); await saved;
    await page.locator('.toast-item').filter({ hasText: '保存しました。' }).waitFor();
    await deadline().waitFor();
    assert(posts.at(-1).operationId === unknownId, 'UNCERTAIN_RETRY_CHANGED_OPERATION_ID');
    assert(!await unloadFlag(), 'ACKNOWLEDGED_SAVE_REMAINS_DIRTY');
    record('injected network abort blocks navigation; same-ID real retry saves and clears guard');
    const beforeSavedNavigation = dialogs.length;
    await click('需要管理'); await heading('需要管理').waitFor();
    assert(dialogs.length === beforeSavedNavigation, 'SAVED_PAGE_PROMPTED');
    record('acknowledged save permits clean navigation');
    return { confirmChoices: 'real shadcn Alert Dialog; pending-operation toast', results, dialogCount: dialogs.length, calendarPosts: posts, cloudflareRequests: 0, fixture: { companyId: new URL(page.url()).searchParams.get('company'), teamId: new URL(page.url()).searchParams.get('team') } };
  } finally {
    await page.unroute('**/api/companies/*/calendar-settings');
    page.off('request', onRequest);
  }
}
