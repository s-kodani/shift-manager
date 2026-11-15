// The fragment never reaches the server or its request logs. Keep the token
// only in this page's memory; do not persist passwords or reset links.
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token');
const validToken = token !== null && /^[A-Za-z0-9_-]{1,256}$/.test(token) && fragment.getAll('token').length === 1;
history.replaceState(null, '', '/reset');
// Opening another email link while this page is already open can be a fragment
// navigation. Reload to read that new link, without sending its token to HTTP.
addEventListener('hashchange', () => { if (location.hash) location.reload(); });
const form = document.getElementById('reset-form');
const fields = document.getElementById('password-fields');
const password = document.getElementById('new-password');
const confirmation = document.getElementById('confirm-password');
const button = document.getElementById('submit-button');
const message = document.getElementById('message');
const toast = document.getElementById('reset-toast');
const loading = document.getElementById('reset-loading');
const pageState = document.getElementById('page-state');
let toastTimer;
let submitting = false;
document.getElementById('close-toast').addEventListener('click', () => { clearTimeout(toastTimer); toast.hidden = true; });

function show(text, kind = 'error') {
  clearTimeout(toastTimer);
  loading.hidden = kind !== 'progress';
  button.setAttribute('aria-busy', String(kind === 'progress'));
  if (kind === 'progress') { loading.textContent = text; return; }
  message.textContent = text;
  message.dataset.kind = kind;
  toast.className = 'toast-item toast-' + kind;
  toast.hidden = false;
  if (form.hidden) { pageState.hidden = false; pageState.textContent = text; pageState.dataset.kind = kind; }
  if (kind === 'success') toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}
if (validToken) fields.disabled = false;
else {
  token = null;
  form.hidden = true;
  show('有効な再設定リンクがありません。メール内のリンクを開き直してください。');
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || !token) return;
  password.removeAttribute('aria-invalid');
  confirmation.removeAttribute('aria-invalid');
  if (password.value.length < 12 || password.value.length > 128) {
    password.setAttribute('aria-invalid', 'true');
    show('パスワードは12〜128文字で入力してください。');
    password.focus();
    return;
  }
  if (password.value !== confirmation.value) {
    confirmation.setAttribute('aria-invalid', 'true');
    show('確認用のパスワードが一致していません。');
    confirmation.focus();
    return;
  }
  submitting = true;
  fields.disabled = true;
  button.textContent = '変更しています…';
  show('パスワードを変更しています。', 'progress');
  try {
    const response = await fetch('/api/auth/reset-password', {
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token, newPassword: password.value}),
      signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (response.ok) {
      token = null;
      password.value = '';
      confirmation.value = '';
      form.hidden = true;
      show('パスワードを変更しました。ログイン画面から、新しいパスワードでログインしてください。', 'success');
    } else if (response.status === 400) {
      token = null;
      form.hidden = true;
      show('リンクが無効、期限切れ、または使用済みです。新しい再設定メールを取得してください。');
    } else {
      show('変更できませんでした。少し待ってから、もう一度お試しください。');
    }
  } catch {
    show('通信を確認して、もう一度お試しください。変更済みの場合は、新しいパスワードでログインしてください。');
  } finally {
    submitting = false;
    loading.hidden = true;
    button.removeAttribute('aria-busy');
    fields.disabled = !token;
    button.textContent = 'パスワードを変更する';
  }
});
