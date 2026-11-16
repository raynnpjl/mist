const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
const pathId = location.pathname.match(/^\/([a-f0-9]{48})\/configure\/?$/)?.[1];
remember('mist.installation', null);
const state = {
  installation: pathId,
  consent: read('mist.notice') === '1', config: null, draft: null, view: 'overview',
  health: [], checking: false, saving: false, keyPending: false, entering: false
};
let toastTimer;

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function theme(value) {
  document.documentElement.dataset.theme = value;
  remember('mist.theme', value);
  const dark = value === 'dark';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#101012' : '#f5f5f7';
  document.querySelectorAll('[data-theme-toggle]').forEach(button => {
    button.innerHTML = icon(dark ? 'sun' : 'moon');
    button.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
  });
  document.querySelectorAll('button[data-theme]').forEach(button => {
    const active = button.dataset.theme === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { 'Content-Type': 'application/json' } : undefined });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: response.status });
  return data;
}

function renderSources() {
  $('source-grid').innerHTML = state.config.providers.map(source => {
    const selected = state.draft.sources.includes(source.id);
    return `<label class="source-card${selected ? ' selected' : ''}" for="source-${escape(source.id)}">
      <span class="source-text"><strong>${escape(source.name)}</strong></span>
      <span class="switch"><input id="source-${escape(source.id)}" data-source="${escape(source.id)}" type="checkbox" role="switch" aria-label="Use ${escape(source.name)}" ${selected ? 'checked' : ''}><span class="switch-track"></span></span>
    </label>`;
  }).join('');
  renderSelection();
}

function renderSelection() {
  $('selection-count').textContent = `${state.draft.sources.length} of ${state.config.providers.length} selected`;
  document.querySelectorAll('.source-card').forEach(card => card.classList.toggle('selected', card.querySelector('input').checked));
  renderSaveBar();
}

function renderLookup() {
  const milliseconds = state.draft.inspectionTimeoutMs;
  $('lookup-time').value = milliseconds;
  $('lookup-output').innerHTML = `${milliseconds / 1000} <span>seconds</span>`;
  $('lookup-time').setAttribute('aria-valuetext', `${milliseconds / 1000} seconds`);
  document.querySelectorAll('[data-time]').forEach(button => {
    const active = Number(button.dataset.time) === milliseconds;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('lookup-help').textContent = milliseconds < 6500
    ? 'A shorter lookup can load the list faster, but more sources may show Unknown quality, bitrate or codec information.'
    : 'A longer window gives sources more time to provide details. Shorter lookups can load the list faster, with more information shown as Unknown.';
  renderSaveBar();
}

function renderOverview() {
  const settings = state.config.settings;
  $('summary-sources').innerHTML = `${settings.sources.length} <small>/ ${state.config.providers.length}</small>`;
  $('summary-lookup').innerHTML = `${settings.inspectionTimeoutMs / 1000} <small>seconds</small>`;
  $('nav-source-count').textContent = settings.sources.length;
  $('manifest').value = new URL(state.config.manifestPath, location.origin).href;
  $('stremio').href = $('manifest').value.replace(/^https?:/, 'stremio:');
}

function renderSaveBar() {
  if (!state.config) return;
  const saved = state.config.settings;
  const dirty = saved.inspectionTimeoutMs !== state.draft.inspectionTimeoutMs ||
    saved.sources.length !== state.draft.sources.length || saved.sources.some(id => !state.draft.sources.includes(id));
  $('save-bar').hidden = !dirty;
  $('save-settings').disabled = state.saving || !state.draft.sources.length;
  $('discard').disabled = state.saving;
  document.querySelectorAll('#source-grid input, #lookup-time, [data-time], #select-all').forEach(control => { control.disabled = state.saving; });
  $('save-hint').textContent = state.draft.sources.length ? 'Applies to your current installation.' : 'Select at least one source to continue.';
}

function showWorkspace() {
  $('welcome').hidden = true;
  $('workspace').hidden = false;
  $('connection').hidden = false;
  renderOverview();
  renderSources();
  renderLookup();
  renderStatus();
}

function navigate(view) {
  if (!state.config || !state.consent) return;
  state.view = view;
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    active ? button.setAttribute('aria-current', 'page') : button.removeAttribute('aria-current');
  });
  if (view === 'status' && !state.health.length) loadStatus();
  window.scrollTo({ top: 0 });
}

function renderStatus() {
  if (!state.config) return;
  const checked = state.config.providers.map(source => state.health.find(row => row.id === source.id));
  const complete = checked.every(Boolean);
  $('status-total').textContent = state.config.providers.length;
  $('status-up').textContent = complete ? checked.filter(row => row.available).length : '—';
  $('status-down').textContent = complete ? checked.filter(row => !row.available).length : '—';
  $('source-status').innerHTML = state.config.providers.map(source => {
    const health = state.health.find(row => row.id === source.id);
    const label = health ? health.available ? 'Up' : 'Down' : state.checking ? 'Checking…' : 'Not checked';
    const tone = !health ? 'pending' : health.available ? 'up' : 'down';
    const date = health ? new Date(health.checkedAt) : undefined;
    const dateLabel = date ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date) : '—';
    return `<article class="status-row" aria-label="${escape(source.name)} source status">
      <div class="status-name"><strong>${escape(source.name)}</strong></div>
      <span class="source-status ${tone}"><span class="status-dot"></span>${label}</span>
      <span class="response-time">${health?.responseMs !== undefined ? `${health.responseMs} ms` : '—'}</span>
      <time class="last-checked" ${date ? `datetime="${escape(health.checkedAt)}" title="${escape(date.toLocaleString())}"` : ''}>${dateLabel}</time>
    </article>`;
  }).join('');
}

async function loadStatus() {
  if (state.checking) return;
  state.checking = true;
  $('refresh-status').disabled = true;
  $('status-error').hidden = true;
  renderStatus();
  try { state.health = (await api(`/api/installations/${state.installation}/status`)).providers; }
  catch (error) { $('status-error').textContent = error.message; $('status-error').hidden = false; }
  finally { state.checking = false; $('refresh-status').disabled = false; renderStatus(); }
}

async function loadConfiguration() {
  state.config = await api(`/api/installations/${state.installation}`);
  state.draft = structuredClone(state.config.settings);
  history.replaceState(null, '', `/${state.installation}/configure`);
  showWorkspace();
}

function openKey() {
  if (!state.consent) return;
  const editing = Boolean(state.config);
  $('key-title').textContent = editing ? 'Update your TMDB key.' : 'TMDB Key Required';
  $('save-key').innerHTML = `${editing ? 'Save API key' : 'Continue'} ${icon('arrow')}`;
  $('cancel-key').hidden = !editing;
  $('api-key').value = '';
  $('key-error').hidden = true;
  document.body.classList.add('key-open');
  $('workspace').inert = true;
  $('welcome').inert = true;
  if (!$('key-dialog').open) $('key-dialog').show();
}

async function enter() {
  if (state.entering || !state.consent) return;
  if (state.config) return;
  state.entering = true;
  $('retry-workspace').hidden = true;
  try {
    if (state.installation) {
      $('welcome-status').textContent = 'Opening your workspace…';
      try { await loadConfiguration(); return; }
      catch (error) {
        if (error.status !== 404) throw error;
        state.installation = undefined;
        $('welcome-status').textContent = 'Reconnect TMDB to open your workspace.';
      }
    }
    openKey();
  } catch (error) {
    $('welcome-status').textContent = 'Could not open your workspace. Please try again.';
    $('retry-workspace').hidden = false;
  } finally { state.entering = false; }
}

$('dmca-dialog').addEventListener('cancel', event => event.preventDefault());
$('understand').addEventListener('click', () => {
  state.consent = true;
  remember('mist.notice', '1');
  $('dmca-dialog').close();
  enter();
});
$('open-notice').addEventListener('click', () => $('dmca-dialog').showModal());
$('key-dialog').addEventListener('cancel', event => { if (!state.config || state.keyPending) event.preventDefault(); });
$('key-dialog').addEventListener('close', () => {
  $('api-key').value = '';
  document.body.classList.remove('key-open');
  $('workspace').inert = false;
  $('welcome').inert = false;
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !$('key-dialog').open || $('dmca-dialog').open) return;
  event.preventDefault();
  if (state.config && !state.keyPending) $('key-dialog').close();
});
$('cancel-key').addEventListener('click', () => $('key-dialog').close());
$('key-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.consent || state.keyPending) return;
  state.keyPending = true;
  $('save-key').disabled = true;
  $('cancel-key').disabled = true;
  $('save-key').textContent = 'Connecting…';
  $('key-error').hidden = true;
  try {
    const data = await api('/api/configure', { method: 'POST', body: JSON.stringify({ apiKey: $('api-key').value, installation: state.installation }) });
    state.installation = data.installation;
    $('api-key').value = '';
    await loadConfiguration();
    $('key-dialog').close();
    toast('TMDB connected. Welcome to Mist.');
  } catch (error) {
    $('key-error').textContent = error.message;
    $('key-error').hidden = false;
  } finally {
    state.keyPending = false;
    $('save-key').disabled = false;
    $('cancel-key').disabled = false;
    $('save-key').innerHTML = `Continue ${icon('arrow')}`;
  }
});

$('source-grid').addEventListener('change', () => {
  state.draft.sources = [...$('source-grid').querySelectorAll('input:checked')].map(input => input.dataset.source);
  renderSelection();
});
$('select-all').addEventListener('click', () => {
  state.draft.sources = state.config.providers.map(source => source.id);
  renderSources();
});
$('lookup-time').addEventListener('input', event => { state.draft.inspectionTimeoutMs = Number(event.target.value); renderLookup(); });
document.querySelectorAll('[data-time]').forEach(button => button.addEventListener('click', () => {
  state.draft.inspectionTimeoutMs = Number(button.dataset.time);
  renderLookup();
}));
$('discard').addEventListener('click', () => {
  state.draft = structuredClone(state.config.settings);
  renderSources(); renderLookup();
});
$('save-settings').addEventListener('click', async () => {
  state.saving = true;
  renderSaveBar();
  $('save-settings').textContent = 'Saving…';
  try {
    const data = await api(`/api/installations/${state.installation}/settings`, { method: 'PUT', body: JSON.stringify(state.draft) });
    state.config.settings = data.settings;
    state.draft = structuredClone(data.settings);
    renderOverview(); renderSources(); renderLookup(); renderStatus();
    toast('Preferences saved. Refresh sources in your player to apply.');
  } catch (error) { toast(error.message); }
  finally { state.saving = false; $('save-settings').innerHTML = `Save changes ${icon('check')}`; renderSaveBar(); }
});

async function copyInstallation() {
  try { await navigator.clipboard.writeText($('manifest').value); toast('Installation URL copied.'); }
  catch { navigate('overview'); $('manifest').focus(); $('manifest').select(); toast('Copy the selected installation URL.'); }
}
$('copy').addEventListener('click', copyInstallation);
$('copy-nuvio').addEventListener('click', copyInstallation);
$('change-key').addEventListener('click', openKey);
$('summary-key').addEventListener('click', openKey);
$('refresh-status').addEventListener('click', loadStatus);
$('brand').addEventListener('click', () => { if (state.config) navigate('overview'); });
$('retry-workspace').addEventListener('click', enter);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.go)));
document.querySelectorAll('[data-theme-toggle]').forEach(button => button.addEventListener('click', () => theme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')));
document.querySelectorAll('button[data-theme]').forEach(button => button.addEventListener('click', () => theme(button.dataset.theme)));
theme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
if (state.consent) enter();
else $('dmca-dialog').showModal();
