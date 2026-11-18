'use strict';

(function () {
  const form = document.getElementById('form');
  const pendingEl = document.getElementById('pending');
  const errorsEl = document.getElementById('errors');
  const statusEl = document.getElementById('status');
  const cancelBtn = document.getElementById('cancel');
  const KEYS = Object.keys(DS.LIMIT_BOUNDS);

  function fmtDuration(ms) {
    const m = Math.max(0, Math.ceil(ms / 60000));
    const h = Math.floor(m / 60);
    return h ? `${h}h ${m % 60}m` : `${m}m`;
  }

  async function send(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (res?.error) throw new Error(res.error);
    return res;
  }

  function showErrors(errors) {
    errorsEl.replaceChildren(...errors.map((e) => {
      const li = document.createElement('li');
      li.textContent = e.message;
      return li;
    }));
    errorsEl.hidden = errors.length === 0;
    for (const k of KEYS) {
      form.elements[k].setAttribute('aria-invalid', String(errors.some((e) => e.key === k)));
    }
  }

  let lastPending = null;

  function renderPending() {
    if (!lastPending) {
      pendingEl.hidden = true;
      cancelBtn.hidden = true;
      return;
    }
    const left = lastPending.effectiveAt - Date.now();
    const at = new Date(lastPending.effectiveAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const v = lastPending.values;
    pendingEl.textContent =
      `Pending: warn after ${v.baseMinutes} min, +${v.extendMinutes} min per extension, ` +
      `${v.maxExtensions} extensions. ` +
      `Applies at ${at} (in ${fmtDuration(left)}).`;
    pendingEl.hidden = false;
    cancelBtn.hidden = false;
  }

  function render(res, { fillForm }) {
    lastPending = res.pending;
    if (fillForm) {
      for (const k of KEYS) form.elements[k].value = res.limits[k];
    }
    renderPending();
  }

  async function load() {
    const res = await send({ type: 'getSettings' });
    const dur = fmtDuration(res.coolOffMs);
    document.getElementById('cooloff').textContent = dur;
    document.getElementById('cooloff2').textContent = dur;
    render(res, { fillForm: true });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.hidden = true;
    const values = {};
    for (const k of KEYS) values[k] = form.elements[k].value;
    try {
      const res = await send({ type: 'proposeLimits', values });
      showErrors(res.errors);
      if (!res.errors.length) {
        render(res, { fillForm: false });
        statusEl.textContent = 'Saved. Current limits stay in effect until the cool-off ends.';
        statusEl.hidden = false;
      }
    } catch (err) {
      showErrors([{ key: '', message: `Could not save: ${err.message}` }]);
    }
  });

  cancelBtn.addEventListener('click', async () => {
    try {
      const res = await send({ type: 'cancelPending' });
      render(res, { fillForm: true });
      statusEl.textContent = 'Pending change cancelled.';
      statusEl.hidden = false;
    } catch (err) {
      showErrors([{ key: '', message: `Could not cancel: ${err.message}` }]);
    }
  });

  // Keep the countdown fresh; reload when the change lands.
  setInterval(() => {
    if (lastPending && Date.now() >= lastPending.effectiveAt) {
      load().catch((err) => showErrors([{ key: '', message: err.message }]));
    } else {
      renderPending();
    }
  }, 30 * 1000);

  load().catch((err) => showErrors([{ key: '', message: `Could not load settings: ${err.message}` }]));

  // ---- sites ---------------------------------------------------------------
  // Add only. Removing a site is done in code (SITE_REMOVALS in shared.js).

  const sitesEl = document.getElementById('sites');
  const siteForm = document.getElementById('siteForm');
  const siteInput = document.getElementById('siteInput');
  const siteError = document.getElementById('siteError');
  const siteStatus = document.getElementById('siteStatus');
  let customList = [];

  function showSiteMessage(el, text) {
    siteError.hidden = true;
    siteStatus.hidden = true;
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
  }

  function renderSites(builtIn, custom) {
    const row = (domain, tagText) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = domain;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = tagText;
      li.append(name, tag);
      return li;
    };
    sitesEl.replaceChildren(...builtIn.map((d) => row(d, 'built in')), ...custom.map((d) => row(d, 'added')));
  }

  async function loadSites() {
    const res = await send({ type: 'getSites' });
    customList = res.custom;
    renderSites(res.builtIn, res.custom);
  }

  siteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    showSiteMessage(null);
    // Validate first, so we never ask for access we won't use.
    const check = DS.addCustomSite(customList, siteInput.value);
    if (check.error) {
      showSiteMessage(siteError, check.error);
      return;
    }
    // Must run straight from the click: the browser only shows the access
    // prompt in response to a user gesture, so nothing is awaited before it.
    chrome.permissions.request({ origins: DS.matchPatterns(check.domain) })
      .then(async (granted) => {
        if (!granted) {
          showSiteMessage(siteError, `Access to ${check.domain} wasn't allowed, so it can't be tracked.`);
          return;
        }
        const res = await send({ type: 'addSite', input: check.domain });
        if (res.message) {
          showSiteMessage(siteError, res.message);
          return;
        }
        siteInput.value = '';
        await loadSites();
        showSiteMessage(siteStatus, `Added ${res.added}. Reload any open ${res.added} tabs to start tracking them.`);
      })
      .catch((err) => showSiteMessage(siteError, `Could not add the site: ${err.message}`));
  });

  loadSites().catch((err) => showSiteMessage(siteError, `Could not load sites: ${err.message}`));
})();
