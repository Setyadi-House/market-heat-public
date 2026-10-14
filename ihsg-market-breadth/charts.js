/* Shared chart primitives for the Margin Monitor (same interaction model, classes and tokens as the breadth charts):
   drag to move dates, wheel or +/- to zoom, Box zoom to select a period, arrows to move, Home to reset, Escape to leave
   box zoom; tooltips that fit small screens; moving averages computed on full history before any slicing. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const finite = Number.isFinite;

  function S(tag, attrs) {
    const element = document.createElementNS(NS, tag);
    for (const key in attrs) element.setAttribute(key, attrs[key]);
    return element;
  }

  /* Moving average of `values` (null = no observation) with integer window `n`.
     basis 'observed': the last n observations, skipping sessions without one (EMA keeps its state across gaps).
     basis 'session': the last n sessions must all be observed (a gap breaks the window; EMA restarts after it).
     The output is defined only on observed sessions; nothing is interpolated or filled with zero. */
  function movingAverage(values, n, type, basis) {
    const out = new Array(values.length).fill(null);
    const alpha = 2 / (n + 1);
    if (basis === 'session') {
      let run = 0, sum = 0, previous = null;
      const window = [];
      values.forEach((value, index) => {
        if (!finite(value)) { run = 0; sum = 0; window.length = 0; previous = null; return; }
        run += 1;
        if (type === 'EMA') {
          previous = previous === null ? value : alpha * value + (1 - alpha) * previous;
          if (run >= n) out[index] = previous;
        } else {
          window.push(value); sum += value;
          if (window.length > n) sum -= window.shift();
          if (window.length === n) out[index] = sum / n;
        }
      });
      return out;
    }
    const window = [];
    let sum = 0, previous = null, seen = 0;
    values.forEach((value, index) => {
      if (!finite(value)) return;
      seen += 1;
      if (type === 'EMA') {
        previous = previous === null ? value : alpha * value + (1 - alpha) * previous;
        if (seen >= n) out[index] = previous;
      } else {
        window.push(value); sum += value;
        if (window.length > n) sum -= window.shift();
        if (window.length === n) out[index] = sum / n;
      }
    });
    return out;
  }

  function linePath(values, x, y) {
    let d = '', on = false;
    values.forEach((value, index) => {
      if (finite(value)) { d += (on ? 'L' : 'M') + x(index).toFixed(2) + ' ' + y(value).toFixed(2) + ' '; on = true; }
      else on = false;
    });
    return d;
  }

  function domain(values, { min = -Infinity, max = Infinity, includeZero = false } = {}) {
    const observed = values.filter(finite);
    if (includeZero) observed.push(0);
    if (!observed.length) return [0, 1];
    let lo = Math.min(...observed), hi = Math.max(...observed);
    const pad = Math.max((hi - lo) * 0.08, Math.abs(hi) * 0.02, 1e-9);
    lo = Math.max(min, includeZero && lo >= 0 ? 0 : lo - pad); hi = Math.min(max, hi + pad);
    if (!(hi > lo)) { hi = lo + 1; }
    return [lo, hi];
  }

  function ticks(count) {
    const k = count > 700 ? 7 : count > 350 ? 6 : count > 150 ? 5 : count > 40 ? 4 : 3;
    return Array.from({ length: k }, (_, i) => Math.round((count - 1) * i / Math.max(1, k - 1)));
  }

  /* One interactive chart over a full date array. `draw(view)` paints the SVG for the visible window and returns
     {W, H, p, tooltip(i)} (i relative to the window). The controller owns the window, the gestures and the tooltip. */
  function create(options) {
    const svg = options.svg, tip = options.tip;
    let view = { start: 0, end: 0 }, applied = { start: 0, end: 0 }, mode = 'pan', scene = null, drag = null, wheel = 0;
    const length = () => options.dates().length;
    const minimum = () => Math.min(options.minCount || 5, length());

    function clamp(start, end) {
      const n = length(), count = Math.max(minimum(), Math.min(n, Math.round(end - start)));
      start = Math.max(0, Math.min(n - count, Math.round(start)));
      return { start, end: start + count };
    }
    function label() {
      const dates = options.dates();
      if (!options.rangeLabel || !dates.length) return;
      const count = view.end - view.start;
      options.rangeLabel.textContent = dates[view.start] + ' → ' + dates[view.end - 1] + ' · ' +
        count.toLocaleString('en-US') + (count === 1 ? ' session' : ' sessions');
      svg.dataset.start = String(view.start); svg.dataset.end = String(view.end);
      svg.dataset.firstDate = dates[view.start]; svg.dataset.lastDate = dates[view.end - 1];
    }
    function redraw() {
      if (!length()) { svg.replaceChildren(); return; }
      hideTip();
      scene = options.draw({ ...view });
      if (drag && drag.selection) svg.appendChild(drag.selection);
      svg.dataset.interactionMode = mode;
      label();
    }
    function setView(start, end, keepApplied) {
      const next = clamp(start, end);
      if (next.start === view.start && next.end === view.end) return false;
      view = next; if (!keepApplied) applied = { ...view };
      redraw();
      return true;
    }
    function apply(start, end) { view = clamp(start, end); applied = { ...view }; redraw(); }
    function reset() { setView(applied.start, applied.end, true); }
    function zoom(factor) {
      const count = view.end - view.start, size = Math.max(minimum(), Math.min(length(), Math.round(count * factor)));
      // Zoom keeps the end of the visible window (the latest date in view); zooming out first adds earlier dates.
      let end = view.end, start = end - size;
      if (start < 0) { start = 0; end = size; }
      return setView(start, end, true);
    }
    function pan(direction) {
      const count = view.end - view.start, step = Math.max(1, Math.round(count * 0.2));
      setView(view.start + direction * step, view.start + direction * step + count, true);
    }
    function geometry(event) {
      if (!scene) return { inside: false, fraction: 0, px: 0, py: 0 };
      const matrix = svg.getScreenCTM();
      if (!matrix) return { inside: false, fraction: 0, px: 0, py: 0 };
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      const { W, H, p } = scene;
      return { px: point.x, py: point.y, fraction: Math.max(0, Math.min(1, (point.x - p.l) / (W - p.l - p.r))),
               inside: point.x >= p.l && point.x <= W - p.r && point.y >= p.t && point.y <= H - p.b };
    }
    function hideTip() { if (tip) tip.style.display = 'none'; }
    function showTip(event) {
      if (!scene || !tip || drag) return;
      const g = geometry(event);
      if (!g.inside) { hideTip(); return; }
      const count = view.end - view.start, i = Math.round(g.fraction * (count - 1));
      tip.textContent = scene.tooltip(i);
      tip.style.display = 'block';
      const wrap = svg.parentElement.getBoundingClientRect(), pad = 6;
      tip.style.maxWidth = Math.max(0, wrap.width - pad * 2) + 'px';
      let left = event.clientX - wrap.left + 12, top = event.clientY - wrap.top + 12;
      if (left + tip.offsetWidth > wrap.width - pad) left = event.clientX - wrap.left - tip.offsetWidth - 12;
      if (top + tip.offsetHeight > wrap.height - pad) top = event.clientY - wrap.top - tip.offsetHeight - 12;
      tip.style.left = Math.max(pad, Math.min(wrap.width - tip.offsetWidth - pad, left)) + 'px';
      tip.style.top = Math.max(pad, Math.min(wrap.height - tip.offsetHeight - pad, top)) + 'px';
    }
    function finish() {
      if (!drag) return;
      if (drag.selection) drag.selection.remove();
      svg.classList.remove('is-panning');
      if (svg.hasPointerCapture && svg.hasPointerCapture(drag.pointerId)) svg.releasePointerCapture(drag.pointerId);
      drag = null;
    }
    function setMode(next) {
      mode = next; svg.dataset.interactionMode = mode;
      if (options.boxButton) {
        options.boxButton.setAttribute('aria-pressed', String(mode === 'zoom'));
        options.boxButton.classList.toggle('active', mode === 'zoom');
      }
    }
    svg.addEventListener('pointerdown', event => {
      const g = geometry(event);
      if (event.button !== 0 || event.isPrimary === false || !g.inside) return;
      event.preventDefault(); svg.focus({ preventScroll: true }); hideTip();
      const selection = mode === 'zoom' ? S('rect', { x: g.px, y: g.py, width: 0, height: 0, class: 'zoom-selection' }) : null;
      if (selection) svg.appendChild(selection);
      drag = { pointerId: event.pointerId, mode, fraction: g.fraction, x: g.px, y: g.py, clientX: event.clientX,
               start: view.start, count: view.end - view.start, width: scene.W - scene.p.l - scene.p.r, selection };
      svg.classList.toggle('is-panning', mode === 'pan');
      if (svg.setPointerCapture) svg.setPointerCapture(event.pointerId);
    });
    svg.addEventListener('pointermove', event => {
      if (!drag) { if (!event.buttons) showTip(event); else hideTip(); return; }
      if (event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      const g = geometry(event);
      if (drag.mode === 'pan') {
        const start = drag.start - (g.px - drag.x) * (drag.count - 1) / drag.width;
        setView(start, start + drag.count, true);
        return;
      }
      const { W, H, p } = scene, x = Math.max(p.l, Math.min(W - p.r, g.px)), y = Math.max(p.t, Math.min(H - p.b, g.py));
      drag.selection.setAttribute('x', Math.min(drag.x, x)); drag.selection.setAttribute('y', Math.min(drag.y, y));
      drag.selection.setAttribute('width', Math.abs(drag.x - x)); drag.selection.setAttribute('height', Math.abs(drag.y - y));
    });
    svg.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const g = geometry(event), count = view.end - view.start;
      const first = Math.round(Math.min(drag.fraction, g.fraction) * (count - 1));
      const last = Math.round(Math.max(drag.fraction, g.fraction) * (count - 1));
      const selected = drag.mode === 'zoom' && Math.abs(event.clientX - drag.clientX) >= 8;
      finish();
      if (selected) setView(view.start + first, view.start + last + 1, true);
    });
    ['pointercancel', 'lostpointercapture'].forEach(type => svg.addEventListener(type, event => {
      if (drag && drag.pointerId === event.pointerId) { finish(); hideTip(); }
    }));
    svg.addEventListener('pointerleave', hideTip);
    svg.addEventListener('wheel', event => {
      if (!event.deltaY || !geometry(event).inside) return;
      event.preventDefault(); finish();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      if (Math.sign(wheel) !== Math.sign(delta)) wheel = 0;
      wheel += delta;
      if (zoom(Math.exp(Math.max(-0.4, Math.min(0.4, wheel * 0.002))))) wheel = 0;
    }, { passive: false });
    svg.addEventListener('keydown', event => {
      if (event.key === '+' || event.key === '=') { event.preventDefault(); finish(); zoom(0.5); }
      else if (event.key === '-') { event.preventDefault(); finish(); zoom(2); }
      else if (event.key === 'Home') { event.preventDefault(); finish(); reset(); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); finish(); pan(event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.key === 'Escape' && (mode === 'zoom' || drag)) {
        // Escape leaves box zoom (or an unfinished rectangle) first; otherwise it reaches an expanded card.
        event.preventDefault(); finish(); hideTip(); setMode('pan');
      }
    });
    if (options.boxButton) options.boxButton.addEventListener('click', () => {
      finish(); hideTip(); setMode(mode === 'pan' ? 'zoom' : 'pan'); svg.focus({ preventScroll: true });
    });
    if (options.resetButton) options.resetButton.addEventListener('click', reset);
    return {
      apply, reset, zoom, pan, redraw, hideTip,
      view: () => ({ ...view }), applied: () => ({ ...applied }), mode: () => mode,
      scene: () => scene,
    };
  }

  function fullscreen(card, button, onChange) {
    function close() {
      card.classList.remove('expanded'); document.body.classList.remove('has-expanded');
      button.setAttribute('aria-pressed', 'false'); button.textContent = 'Expand';
      onChange(); button.focus({ preventScroll: true });
    }
    button.addEventListener('click', () => {
      if (card.classList.contains('expanded')) { close(); return; }
      card.classList.add('expanded'); document.body.classList.add('has-expanded');
      button.setAttribute('aria-pressed', 'true'); button.textContent = 'Close expanded view';
      onChange();
    });
    card.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented && card.classList.contains('expanded')) close();
    });
    return close;
  }

  window.IHSGCharts = Object.freeze({ S, movingAverage, linePath, domain, ticks, create, fullscreen, finite });
})();
