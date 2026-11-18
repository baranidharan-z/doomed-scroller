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
})();
