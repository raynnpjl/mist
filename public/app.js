const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {} };
remember('mist.installation', null);
const state = {
  installation: undefined,
  consent: read('mist.notice') === '1', config: null, draft: null, view: 'overview',
  health: [], checking: false, saving: false, keyPending: false, entering: false, access: false
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
  if (response.status === 401 && path !== '/api/access') {
    lockAccess();
  }
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: response.status });
  return data;
}

function lockAccess() {
  navigate('overview');
  state.access = false;
  state.installation = undefined;
  state.config = state.draft = null;
  state.health = [];
  $('workspace').hidden = $('connection').hidden = $('sign-out').hidden = true;
  $('welcome').hidden = false;
  $('welcome-status').textContent = 'Enter your access key to continue.';
  openKey();
}

function renderSources() {
  $('source-grid').innerHTML = state.draft.sourceOrder.map(id => {
    const source = state.config.providers.find(source => source.id === id);
    const selected = state.draft.sources.includes(source.id);
    const name = source.name;
    return `<div class="source-option" data-source-row="${escape(source.id)}" role="listitem">
      <button class="source-drag" type="button" data-reorder="${escape(source.id)}" aria-label="Reorder ${escape(name)}" aria-describedby="source-order-help" title="Drag to reorder, or use the arrow keys" ${state.saving ? 'disabled' : ''}><span aria-hidden="true">⠿</span></button>
      <label class="source-text" for="source-${escape(source.id)}"><strong>${escape(name)}</strong>${source.id === 'mkvdrama' ? '<small>PixelDrain · Send</small>' : ''}</label>
      <label class="switch"><input id="source-${escape(source.id)}" data-source="${escape(source.id)}" type="checkbox" role="switch" aria-label="Use ${escape(name)}" ${selected ? 'checked' : ''}><span class="switch-track"></span></label>
    </div>`;
  }).join('');
  $('resolution-options').innerHTML = [...state.config.resolutions].sort((a, b) => (Number(b) || 0) - (Number(a) || 0)).map(resolution => {
    return `<label class="resolution-option">
      <input type="checkbox" name="resolution" value="${escape(resolution)}" ${state.draft.resolutions.includes(resolution) ? 'checked' : ''}>
      <span>${resolution === 2160 ? '4K' : resolution === 'unknown' ? 'Unknown' : `${resolution}p`}</span>
    </label>`;
  }).join('');
  $('resolution-first').checked = state.draft.resolutionFirst;
  renderSelection();
}

function renderSelection() {
  $('selection-count').textContent = `${state.draft.sources.length} enabled`;
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
  const dirty = saved.inspectionTimeoutMs !== state.draft.inspectionTimeoutMs || saved.resolutionFirst !== state.draft.resolutionFirst ||
    saved.sources.length !== state.draft.sources.length || saved.sources.some(id => !state.draft.sources.includes(id)) ||
    saved.sourceOrder.some((id, index) => id !== state.draft.sourceOrder[index]) ||
    saved.resolutions.length !== state.draft.resolutions.length || saved.resolutions.some(resolution => !state.draft.resolutions.includes(resolution));
  $('save-bar').hidden = !dirty;
  $('save-settings').disabled = state.saving || !state.draft.sources.length || !state.draft.resolutions.length;
  $('discard').disabled = state.saving;
  document.querySelectorAll('#source-grid input, #resolution-options input, #resolution-first, #lookup-time, [data-time], #select-all').forEach(control => { control.disabled = state.saving; });
  document.querySelectorAll('[data-reorder]').forEach(handle => { handle.disabled = state.saving; });
  $('save-hint').textContent = !state.draft.sources.length ? 'Select at least one source to continue.' :
    !state.draft.resolutions.length ? 'Select at least one resolution to continue.' : 'Applies to your current installation.';
}

function showWorkspace() {
  $('welcome').hidden = true;
  $('workspace').hidden = false;
  $('connection').hidden = false;
  $('sign-out').hidden = false;
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
  const unlocking = !state.access;
  $('sign-out').hidden = unlocking;
  const editing = Boolean(state.config);
  $('key-title').textContent = unlocking ? 'Access Key Required' : editing ? 'Update your TMDB key.' : 'TMDB Key Required';
  $('key-description').textContent = unlocking ? 'Enter your access key to continue Mist setup.' : 'Connect TMDB to match your TMDB-powered catalog with the right information';
  $('key-label').textContent = unlocking ? 'Access key' : 'TMDB API key';
  $('api-key').name = unlocking ? 'accessKey' : 'apiKey';
  $('api-key').setAttribute('minlength', unlocking ? '64' : '32');
  $('api-key').setAttribute('maxlength', unlocking ? '64' : '32');
  $('api-key').pattern = unlocking ? '[a-f0-9]{64}' : '[a-fA-F0-9]{32}';
  $('api-key').placeholder = unlocking ? 'Your private access key' : 'Your TMDB API key';
  $('key-help').innerHTML = `${icon('lock')}${unlocking ? 'Contact Mist\'s developer for support' : 'Encrypted and saved on the server'}`;
  $('tmdb-key-link').hidden = unlocking;
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
    if (!state.access) {
      const access = await api('/api/access');
      state.access = access.authenticated;
      state.installation = access.installation;
      if (!state.access) { openKey(); return; }
    }
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
    if (error.status === 401) return;
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
  if ($('key-dialog').open) return;
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
$('sign-out').addEventListener('click', async () => {
  try {
    await api('/api/access', { method: 'DELETE' });
    lockAccess();
    history.replaceState(null, '', '/configure');
  } catch (error) { toast(error.message); }
});
$('key-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!state.consent || state.keyPending) return;
  state.keyPending = true;
  const unlocking = !state.access;
  $('save-key').disabled = true;
  $('sign-out').disabled = true;
  $('cancel-key').disabled = true;
  $('save-key').textContent = unlocking ? 'Verifying…' : 'Connecting…';
  $('key-error').hidden = true;
  try {
    if (unlocking) {
      const access = await api('/api/access', { method: 'POST', body: JSON.stringify({ accessKey: $('api-key').value }) });
      state.access = true;
      state.installation = access.installation;
      $('key-dialog').close();
      await enter();
      return;
    }
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
    $('sign-out').disabled = false;
    $('cancel-key').disabled = false;
    $('save-key').innerHTML = `Continue ${icon('arrow')}`;
  }
});

function applySourceOrder(handle) {
  const previous = state.draft.sourceOrder.indexOf(handle.dataset.reorder) + 1;
  state.draft.sourceOrder = [...$('source-grid').children].map(row => row.dataset.sourceRow);
  renderSelection();
  const position = state.draft.sourceOrder.indexOf(handle.dataset.reorder) + 1;
  const source = state.config.providers.find(source => source.id === handle.dataset.reorder);
  if (position !== previous) $('source-order-status').textContent = `${source.name} moved to position ${position} of ${state.draft.sourceOrder.length}.`;
  handle.focus();
}

let sourceDrag;
function moveSourceDrag() {
  const { row, handle, pointerId, floating, y, offsetY, reducedMotion } = sourceDrag;
  const grid = $('source-grid'), top = y - offsetY;
  floating.style.top = `${top}px`;
  const rows = [...grid.children].filter(item => item !== row);
  const gridTop = grid.getBoundingClientRect().top, center = top + row.offsetHeight / 2;
  const next = rows.find(item => center < gridTop + item.offsetTop + item.offsetHeight / 2) || null;
  if (row.nextElementSibling === next) return;
  const positions = rows.map(item => [item, item.getBoundingClientRect().top]);
  rows.forEach(item => item.getAnimations().forEach(animation => animation.cancel()));
  grid.insertBefore(row, next);
  handle.setPointerCapture(pointerId);
  if (!reducedMotion) positions.forEach(([item, before]) => {
    const distance = before - item.getBoundingClientRect().top;
    if (distance) item.animate([{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }],
      { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' });
  });
}

function scrollSourceDrag() {
  if (!sourceDrag) return;
  const edge = 80, y = sourceDrag.y;
  const distance = y < edge ? y - edge : y > innerHeight - edge ? y - innerHeight + edge : 0;
  if (distance) {
    window.scrollBy(0, Math.max(-12, Math.min(12, distance / 5)));
    moveSourceDrag();
  }
  sourceDrag.frame = requestAnimationFrame(scrollSourceDrag);
}

function finishSourceDrag(event) {
  if (!sourceDrag || event.pointerId !== sourceDrag.pointerId) return;
  if (event.type === 'pointerup') { sourceDrag.y = event.clientY; moveSourceDrag(); }
  const { row, handle, pointerId, floating, frame, reducedMotion } = sourceDrag;
  sourceDrag = null;
  cancelAnimationFrame(frame);
  const landing = row.getBoundingClientRect();
  row.classList.remove('dragging');
  if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  if (event.type === 'pointerup') {
    applySourceOrder(handle);
    if (reducedMotion) floating.remove();
    else floating.animate([{ top: floating.style.top, opacity: 1, transform: 'scale(1.015)' },
      { top: `${landing.top}px`, opacity: 0, transform: 'scale(1)' }], { duration: 140, easing: 'ease-out' }).onfinish = () => floating.remove();
  } else {
    floating.remove();
    renderSources();
    $('source-grid').querySelector(`[data-reorder="${handle.dataset.reorder}"]`).focus();
  }
}

$('source-grid').addEventListener('pointerdown', event => {
  const handle = event.target.closest('[data-reorder]');
  if (!handle || handle.disabled || event.button !== 0 || sourceDrag) return;
  event.preventDefault();
  handle.focus();
  const row = handle.closest('[data-source-row]'), bounds = row.getBoundingClientRect();
  const floating = row.cloneNode(true);
  floating.classList.add('source-floating');
  floating.inert = true;
  floating.setAttribute('aria-hidden', 'true');
  floating.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
  Object.assign(floating.style, { top: `${bounds.top}px`, left: `${bounds.left}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
  document.body.append(floating);
  sourceDrag = { row, handle, floating, pointerId: event.pointerId, y: event.clientY, offsetY: event.clientY - bounds.top,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches };
  row.classList.add('dragging');
  handle.setPointerCapture(event.pointerId);
});
$('source-grid').addEventListener('pointermove', event => {
  if (!sourceDrag || event.pointerId !== sourceDrag.pointerId) return;
  sourceDrag.y = event.clientY;
  moveSourceDrag();
  if (!sourceDrag.frame) sourceDrag.frame = requestAnimationFrame(scrollSourceDrag);
});
['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => $('source-grid').addEventListener(type, finishSourceDrag));
$('source-grid').addEventListener('keydown', event => {
  if (sourceDrag) {
    if (event.key === 'Escape') { event.preventDefault(); finishSourceDrag({ type: 'pointercancel', pointerId: sourceDrag.pointerId }); }
    return;
  }
  const handle = event.target.closest('[data-reorder]');
  if (!handle || handle.disabled || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const rows = [...$('source-grid').children];
  const row = handle.closest('[data-source-row]'), from = rows.indexOf(row);
  const to = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : from + (event.key === 'ArrowUp' ? -1 : 1);
  if (to < 0 || to >= rows.length || to === from) return;
  if (to < from) rows[to].before(row); else rows[to].after(row);
  applySourceOrder(handle);
});
$('source-grid').addEventListener('change', () => {
  state.draft.sources = [...$('source-grid').querySelectorAll('input:checked')].map(input => input.dataset.source);
  renderSelection();
});
$('resolution-options').addEventListener('change', () => {
  state.draft.resolutions = [...$('resolution-options').querySelectorAll('input:checked')].map(input => input.value === 'unknown' ? 'unknown' : Number(input.value));
  renderSelection();
});
$('resolution-first').addEventListener('change', event => {
  state.draft.resolutionFirst = event.target.checked;
  renderSaveBar();
});
$('select-all').addEventListener('click', () => {
  state.draft.sources = [...state.draft.sourceOrder];
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
