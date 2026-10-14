/* The dashboard shell: Market Breadth, Margin Monitor and Data Status as WAI-ARIA tabs (#breadth, #margin,
   #margin/CODE, #status), the Margin data loaded only when a Margin view is first opened, and the Breadth half of
   Data Status. Each dataset fails on its own: a Margin load or validation failure never touches Market Breadth. */
(function () {
  'use strict';
  const tabs = Array.from(document.querySelectorAll('.tabs [role="tab"]'));
  const panel = tab => document.getElementById(tab.getAttribute('aria-controls'));
  const byName = name => tabs.find(tab => tab.dataset.tab === name) || tabs[0];
  const $ = id => document.getElementById(id);
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  let margin = 'idle';                                       // idle | loading | done

  /* Theme: app.js binds the button after its payload validates; without it the preference still works here. */
  const themeButton = $('themeBtn');
  if (themeButton && !themeButton.onclick) {
    const dark = () => document.body.classList.contains('dark');
    const label = () => { themeButton.textContent = dark() ? 'Light mode' : 'Dark mode'; };
    try { if (localStorage.getItem('ihsg-theme') === 'dark') document.body.classList.add('dark'); } catch (e) { /* storage blocked */ }
    label();
    themeButton.onclick = () => {
      document.body.classList.toggle('dark');
      try { localStorage.setItem('ihsg-theme', dark() ? 'dark' : 'light'); } catch (e) { /* storage blocked */ }
      label();
    };
  }

  function loadMargin() {
    if (margin !== 'idle') return;
    margin = 'loading';
    const api = window.IHSGMargin;
    if (!api) {
      margin = 'done';
      $('marginLoading').hidden = true;
      $('marginError').textContent = 'The Margin Monitor could not start. Market Breadth is unaffected.';
      $('marginError').className = 'banner show';
      set('smState', 'The Margin Monitor could not start; nothing is shown.');
      return;
    }
    const script = document.createElement('script');
    script.src = 'margin-data.js';
    script.onload = () => { margin = 'done'; api.init(); shown(); };
    script.onerror = () => { margin = 'done'; api.loadFailed(); shown(); };
    document.body.appendChild(script);
  }

  function renderBreadthStatus() {
    const B = window.IHSG_PUBLIC_DATA, ready = window.IHSG_BREADTH_READY === true;
    const chip = $('sbChip'), banner = $('staleBanner');
    chip.textContent = ready ? 'VALID' : 'NOT SHOWN';
    chip.dataset.status = ready ? 'VALID' : 'FAILED';
    set('sbValid', ready ? 'Passed: the aggregate arrays are aligned and every chart was drawn.'
      : 'Failed: ' + ((banner && banner.textContent) || 'the breadth data could not be loaded') + ' The breadth charts are not shown.');
    if (!ready || !B || !B.meta || !Array.isArray(B.dates)) {
      ['sbMarket', 'sbHistory', 'sbCoverage', 'sbSources'].forEach(id => set(id, '—'));
      return;
    }
    const last = B.dates.length - 1, target = B.target && B.target[last], eligible = B.eligible && B.eligible[last];
    set('sbMarket', B.meta.market_as_of);
    set('sbHistory', B.meta.history_start + ' → ' + B.meta.market_as_of + ' (' + B.dates.length.toLocaleString('en-US') + ' sessions)');
    set('sbCoverage', Number.isInteger(target) && target > 0 && Number.isInteger(eligible)
      ? (100 * eligible / target).toFixed(2) + '% (' + eligible + ' valid of ' + target + ' target stocks on ' + B.dates[last] + ')' : '—');
    set('sbSources', B.meta.source_priority || '—');
  }

  function current() { const tab = tabs.find(item => item.getAttribute('aria-selected') === 'true'); return tab ? tab.dataset.tab : 'breadth'; }
  function shown() {
    if (current() === 'margin' && window.IHSGMargin) window.IHSGMargin.redraw();
    if (current() === 'status') { renderBreadthStatus(); if (window.IHSGMargin) window.IHSGMargin.renderStatus(); }
  }
  function select(tab, options) {
    tabs.forEach(item => {
      const on = item === tab;
      item.setAttribute('aria-selected', String(on));
      item.tabIndex = on ? 0 : -1;
      panel(item).hidden = !on;
    });
    if (options.focus) tab.focus();
    const name = tab.dataset.tab;
    if (options.hash) {
      const keep = name === 'margin' && /^#margin\/[A-Z0-9-]{1,16}$/.test(location.hash);
      if (!keep && location.hash !== '#' + name) {
        try { history.replaceState(null, '', '#' + name); } catch (e) { /* file:// */ }
      }
    }
    if (name !== 'breadth') loadMargin();
    shown();
  }
  function route() {
    const name = (location.hash.match(/^#(breadth|margin|status)(?:\/|$)/) || [])[1] || 'breadth';
    select(byName(name), { focus: false, hash: false });
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab, { focus: false, hash: true }));
    tab.addEventListener('keydown', event => {
      const keys = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
      if (!(event.key in keys)) return;
      event.preventDefault();
      select(tabs[(keys[event.key] + tabs.length) % tabs.length], { focus: true, hash: true });
    });
  });
  window.addEventListener('hashchange', route);
  route();
})();
