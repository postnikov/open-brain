// Token exists only in this page's memory. Reload/logout removes it.
const nativeFetch = window.fetch.bind(window);
let token = '';
let login;
async function authenticate() {
  if (login) return login;
  login = new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    const form = document.createElement('form');
    const label = document.createElement('label');
    label.textContent = 'Open Brain — access token';
    const input = document.createElement('input');
    input.type = 'password'; input.autocomplete = 'off'; input.required = true;
    const button = document.createElement('button');
    button.type = 'submit'; button.textContent = 'Unlock';
    const error = document.createElement('p');
    label.append(input); form.append(label, button, error); dialog.append(form);
    dialog.addEventListener('cancel', e => e.preventDefault());
    form.addEventListener('submit', async e => {
      e.preventDefault(); button.disabled = true;
      try {
        const candidate = input.value.trim();
        const response = await nativeFetch('/health', { headers: { Authorization: 'Bearer ' + candidate }, redirect: 'error', cache: 'no-store' });
        if (!response.ok) throw new Error();
        token = candidate; input.value = ''; dialog.close(); dialog.remove(); resolve();
      } catch { error.textContent = 'Could not unlock. Check the token and connection.'; }
      finally { button.disabled = false; }
    });
    document.body.append(dialog); dialog.showModal(); input.focus();
  });
  try { await login; } finally { login = undefined; }
}
await authenticate();
window.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : input, location.href);
  if (url.origin !== location.origin) throw new Error('Only same-origin requests are allowed');
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  headers.set('Authorization', 'Bearer ' + token);
  const response = await nativeFetch(input, { ...init, headers, redirect: 'error', cache: 'no-store' });
  if (response.status === 401) {
    token = '';
    await authenticate();
    // Do not automatically replay mutations after uncertain outcomes.
    throw new Error('Session unlocked. Repeat your action.');
  }
  return response;
};
const vaultInput = document.getElementById('vaultPath');
if (vaultInput) vaultInput.closest('.import-section')?.remove();
const lock = document.createElement('button');
lock.textContent = 'Lock'; lock.addEventListener('click', () => { token = ''; location.reload(); });
document.body.prepend(lock);
await import('./main.js');
