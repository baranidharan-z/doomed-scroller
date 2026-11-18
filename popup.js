'use strict';

(async function () {
  const now = Date.now();
  const key = DS.dayKey(now);
  const got = await chrome.storage.local.get([key, 'settings', 'customSites']);
  const day = got[key] || {};
  // Read-only view: resolve a due pending change for display; the background
  // persists the promotion on its next tick.
  const { cfg, settings } = DS.resolveSettings(got.settings, now);
  const tbody = document.getElementById('rows');

  // Built-in sites, then sites added in settings (keyed by domain).
  for (const site of [...Object.keys(DS.SITES), ...DS.customSites(got.customSites)]) {
    const rec = { ...DS.emptyRecord(), ...(day[site] || {}) };
    const t = DS.thresholds(rec, cfg);
    const state = DS.stateOf(rec, cfg, now);
    const cells = [
      site,
      `${Math.floor(rec.activeMs / 60000)}m`,
      `${Math.max(0, Math.ceil((t.ms - rec.activeMs) / 60000))}m`,
      `${rec.extensions}/${cfg.maxExtensions}`,
      state,
    ];
    const tr = document.createElement('tr');
    cells.forEach((text, i) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (i >= 1 && i <= 3) td.className = 'num';
      if (i === 4) td.className = state;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  let foot =
    `Warns after ${cfg.baseMinutes} min a day per site. ` +
    `Blocks after ${cfg.maxExtensions} extensions.`;
  if (settings.pending) {
    const at = new Date(settings.pending.effectiveAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    foot += ` New limits pending, apply at ${at}.`;
  }
  document.getElementById('foot').textContent = foot;

  document.getElementById('settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
