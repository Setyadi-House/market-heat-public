/* IDX Margin Monitor and Data Status. Reads window.IHSG_MARGIN_DATA (margin-data.js, official IDX Margin records only),
   validates it before drawing, and never touches the breadth data or charts. */
(function () {
  'use strict';
  const C = window.IHSGCharts;
  const finite = Number.isFinite;
  const SCHEMAS = [1];
  const TOP = ['meta', 'dates', 'status', 'records', 'total_value', 'offsets', 'codes', 'code', 'value', 'volume',
               'frequency', 'monthly'];
  const ARCHIVE = ['first_date', 'last_date', 'sessions', 'records', 'codes'];
  const RANGES = ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'];
  const CODE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const STATUS_TEXT = {
    CHECKPOINT: 'Verified checkpoint; no update has run yet',
    CURRENT: 'Up to date with the latest expected session at the time of the check',
    UPDATED: 'Updated with new verified sessions',
    BEHIND: 'Behind: sessions are waiting for the next update run',
    UNAVAILABLE: 'Update unavailable: the last verified data is shown',
    FAILED: 'Update failed: the last verified data is shown',
    HELD: 'Update held: a new file waits for its date to be confirmed',
  };
  const DETAIL_TEXT = {
    CHECKPOINT_IMPORT: 'Imported from the verified historical archive.',
    UPDATES_NOT_ENABLED: 'Automatic Margin updates have not been enabled yet.',
    CALENDAR_UNPROVEN: 'The official exchange calendar for these dates is not pinned yet.',
    REQUEST_BUDGET: 'More sessions are pending than one run collects.',
    DATE_CROSS_CHECK_UNAVAILABLE: 'The All Stock daily data needed to confirm the file’s date is not available yet.',
    DATE_CROSS_CHECK_FAILED: 'A downloaded file did not match the All Stock data of its date; it was not used.',
    EXPORT_QC_FAILED: 'A downloaded file failed its quality checks; it was not used.',
    REPEATED_FAILURE_OWNER_REVIEW: 'A session failed its checks repeatedly and waits for review.',
    IDX_ACCESS_REFUSED: 'The IDX website refused the request.',
    IDX_ACCESS_HOLD: 'Requests to IDX are on hold until access is resolved.',
    IDX_ACCESS_SCREENING_HOLD: 'The IDX website showed an access check; requests are on hold until it is resolved.',
    PROXY_PROVIDER_HOLD: 'The network route provider refused the IDX website; requests are on hold.',
    PROXY_ROUTE_REFUSED: 'The network route refused the connection.',
    PROXY_POOL_UNAVAILABLE: 'No network route was available for IDX requests.',
    PROXY_STATE_UNAVAILABLE: 'The network route state could not be read.',
    RATE_LIMITED: 'IDX asked to slow down; the next run waits.',
    CONNECTION_FAILED: 'The connection to IDX failed.',
    IDX_RUN_HALTED: 'IDX requests stopped earlier in the same run.',
    IDX_PAGE_ERROR: 'The IDX page returned an error.',
    PAGE_STRUCTURE_OR_TIMEOUT: 'The IDX page did not respond as expected.',
    STATE_UNAVAILABLE: 'The private Margin state could not be read.',
    UPDATE_FAILED: 'The update did not complete.',
  };
  const updateSentence = update => {
    const detail = update.detail ? (DETAIL_TEXT[update.detail] || update.detail) : '';
    return STATUS_TEXT[update.status] + (detail ? ' — ' + detail.replace(/\.$/, '') : '') + '.';
  };
  let M = null, ready = false, error = null;
  let stockIndex = null, codeIndex = null;
  const charts = {};
  const $ = id => document.getElementById(id);
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem('ihsg-margin-' + key); return v === null ? fallback : v; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem('ihsg-margin-' + key, String(value)); } catch (e) { /* storage blocked */ } },
  };
  const state = {
    view: store.get('agg-view', 'value') === 'index' ? 'index' : 'value',
    base: null,
    agg: { type: store.get('agg-type', 'SMA'), n: Number(store.get('agg-n', 20)), raw: store.get('agg-raw', '1') !== '0' },
    stock: { type: store.get('stock-type', 'SMA'), n: Number(store.get('stock-n', 20)),
             basis: store.get('stock-basis', 'observed') === 'session' ? 'session' : 'observed' },
    code: null,
    daily: { date: null, key: 'value', dir: -1, filter: '' },
    period: { start: null, end: null, key: 'value', dir: -1, filter: '' },
  };
  ['agg', 'stock'].forEach(name => {
    if (!['SMA', 'EMA'].includes(state[name].type)) state[name].type = 'SMA';
    if (!Number.isInteger(state[name].n) || state[name].n < 1 || state[name].n > 1260) state[name].n = 20;
  });

  /* ------------------------------------------------------------------------------------------------ validation */

  function fail(code) { throw new Error(code); }
  function isInt(value, nullable) { return value === null ? !!nullable : Number.isSafeInteger(value) && value >= 0; }
  function exactKeys(value, keys) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length &&
      keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
  }
  function validate(data) {
    if (!exactKeys(data, TOP)) fail('MARGIN_KEYS');
    const meta = data.meta;
    if (!meta || !SCHEMAS.includes(meta.schema_version) || meta.kind !== 'ihsg-idx-margin-public') fail('MARGIN_SCHEMA');
    const n = data.dates.length;
    if (!n || !data.dates.every((day, i) => DAY.test(day) && (i === 0 || data.dates[i - 1] < day))) fail('MARGIN_DATES');
    if (![data.status, data.records, data.total_value].every(a => Array.isArray(a) && a.length === n) ||
        !Array.isArray(data.offsets) || data.offsets.length !== n + 1) fail('MARGIN_ALIGNMENT');
    const records = data.code.length;
    if (![data.value, data.volume, data.frequency].every(a => Array.isArray(a) && a.length === records)) fail('MARGIN_RECORDS');
    if (!data.codes.every((code, i) => CODE.test(code) && (i === 0 || data.codes[i - 1] < code))) fail('MARGIN_CODES');
    if (data.offsets[0] !== 0 || data.offsets[n] !== records) fail('MARGIN_OFFSETS');
    for (let r = 0; r < records; r++) {
      if (!isInt(data.code[r]) || data.code[r] >= data.codes.length || !isInt(data.value[r]) || !isInt(data.volume[r]) ||
          !isInt(data.frequency[r])) fail('MARGIN_VALUES');
    }
    let verified = 0;
    for (let i = 0; i < n; i++) {
      const a = data.offsets[i], b = data.offsets[i + 1];
      if (!isInt(a) || !isInt(b) || b < a) fail('MARGIN_OFFSETS');
      if (data.status[i] === 'U') {
        if (b !== a || data.records[i] !== null || data.total_value[i] !== null) fail('MARGIN_UNVERIFIED_HAS_DATA');
        continue;
      }
      if (data.status[i] !== 'V') fail('MARGIN_STATUS');
      verified += 1;
      let sum = 0;
      for (let r = a; r < b; r++) {
        if (r > a && data.code[r] <= data.code[r - 1]) fail('MARGIN_DAILY_CODES');
        sum += data.value[r];
      }
      if (b === a || data.records[i] !== b - a || data.total_value[i] !== sum) fail('MARGIN_TOTALS');
    }
    if (meta.sessions !== verified || meta.records !== records || meta.codes !== data.codes.length ||
        meta.first_date !== data.dates[0] || meta.latest_date !== data.dates[n - 1]) fail('MARGIN_COUNTS');
    const base = data.dates.indexOf(meta.base_date);
    if (base < 0 || data.status[base] !== 'V' || !(data.total_value[base] > 0) || meta.base_value !== data.total_value[base]) fail('MARGIN_BASE');
    if (!meta.update || !STATUS_TEXT[meta.update.status] || !Array.isArray(meta.update.pending_dates) ||
        !Array.isArray(meta.update.unverified_dates)) fail('MARGIN_UPDATE');
    const archive = meta.archive;
    if (!exactKeys(archive, ARCHIVE) || !DAY.test(archive.first_date) || !DAY.test(archive.last_date) ||
        !['sessions', 'records', 'codes'].every(key => isInt(archive[key]))) fail('MARGIN_ARCHIVE');
    if (!meta.snapshot || !Number.isSafeInteger(meta.snapshot.revision) || typeof meta.snapshot.content_sha256 !== 'string') fail('MARGIN_SNAPSHOT');
    if (!Array.isArray(data.monthly)) fail('MARGIN_MONTHLY');
    return data;
  }

  /* ------------------------------------------------------------------------------------------------- helpers */

  const fmtInt = value => finite(value) ? Math.round(value).toLocaleString('en-US') : '—';
  const fmtIdr = value => finite(value) ? 'IDR ' + fmtInt(value) : '—';
  function fmtBn(value, digits = 2) {
    if (!finite(value)) return '—';
    if (Math.abs(value) >= 1e12) return 'IDR ' + (value / 1e12).toFixed(digits) + ' tn';
    if (Math.abs(value) >= 1e9) return 'IDR ' + (value / 1e9).toFixed(digits) + ' bn';
    if (Math.abs(value) >= 1e6) return 'IDR ' + (value / 1e6).toFixed(digits) + ' m';
    return 'IDR ' + fmtInt(value);
  }
  const fmtPct = value => finite(value) ? value.toFixed(2) + '%' : '—';
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const key in attrs || {}) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'class') node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    (children || []).forEach(child => node.appendChild(child));
    return node;
  }
  function indexOfDate(day) {
    let lo = 0, hi = M.dates.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (M.dates[mid] < day) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function verifiedIndexAtOrBefore(day) {
    let i = Math.min(indexOfDate(day), M.dates.length - 1);
    if (M.dates[i] > day) i -= 1;
    while (i >= 0 && M.status[i] !== 'V') i -= 1;
    return i;
  }
  function presetStart(end, preset) {
    if (preset === 'ALL') return 0;
    const d = new Date(M.dates[end - 1] + 'T12:00:00Z');
    if (preset === '1M') d.setUTCMonth(d.getUTCMonth() - 1);
    else if (preset === '3M') d.setUTCMonth(d.getUTCMonth() - 3);
    else if (preset === '6M') d.setUTCMonth(d.getUTCMonth() - 6);
    else if (preset === '1Y') d.setUTCFullYear(d.getUTCFullYear() - 1);
    else if (preset === 'YTD') return indexOfDate(M.dates[end - 1].slice(0, 4) + '-01-01');
    return Math.min(end - 1, indexOfDate(d.toISOString().slice(0, 10)));
  }
  function buildIndexes() {
    stockIndex = M.codes.map(() => ({ dates: [], records: [] }));
    for (let i = 0; i < M.dates.length; i++) {
      for (let r = M.offsets[i]; r < M.offsets[i + 1]; r++) { stockIndex[M.code[r]].dates.push(i); stockIndex[M.code[r]].records.push(r); }
    }
    codeIndex = new Map(M.codes.map((code, i) => [code, i]));
  }
  function download(name, lines) {
    const blob = new Blob([lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function csvHeader(title) {
    const snap = M.meta.snapshot;
    return ['# IHSG Margin Monitor — ' + title,
            '# Source: ' + M.meta.source + ' (' + M.meta.source_url + ')',
            '# Snapshot revision ' + snap.revision + ', generated ' + snap.generated_at + ', content SHA-256 ' + snap.content_sha256,
            '# Values are reported Nilai in IDR (transaction value of Margin-section trades), not outstanding margin debt.'];
  }
  const csvCell = value => { const text = value === null || value === undefined ? '' : String(value); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; };

  /* --------------------------------------------------------------------------------------------- aggregate */

  function aggregateSeries() {
    const base = M.dates.indexOf(state.base), reference = M.total_value[base];
    const raw = M.total_value.map(value => value === null ? null : state.view === 'index' ? 100 * value / reference : value);
    const smoothed = C.movingAverage(raw, state.agg.n, state.agg.type, 'observed');
    return { raw, smoothed };
  }
  /* The SVG coordinate system follows the element's rendered size, so text is never stretched (expanded view, phone
     widths). A hidden chart (another tab) draws at the default size and is redrawn when shown. */
  function canvas(svg, fallbackHeight) {
    const box = svg.getBoundingClientRect();
    const W = box.width >= 240 ? Math.round(box.width) : 1100, H = box.height >= 160 ? Math.round(box.height) : fallbackHeight;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    return { W, H, p: { l: W < 520 ? 50 : 62, r: 14, t: 24, b: 30 } };
  }
  function dateTicks(count, width) {
    const k = Math.max(2, Math.min(C.ticks(count).length, Math.floor(width / 92)));
    return Array.from({ length: k }, (_, i) => Math.round((count - 1) * i / Math.max(1, k - 1)));
  }
  /* Round tick values (1, 2, 2.5 or 5 × a power of ten) in the axis unit (`scale` IDR per unit). */
  function niceStep(span) {
    const raw = span / 5, power = Math.pow(10, Math.floor(Math.log10(raw))), unit = raw / power;
    return (unit < 1.5 ? 1 : unit < 2.25 ? 2 : unit < 3.5 ? 2.5 : unit < 7.5 ? 5 : 10) * power;
  }
  function axes(svg, W, H, p, lo, hi, scale, dates) {
    const step = niceStep(hi - lo), digits = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step / scale) - 1e-9)));
    const label = v => (v / scale).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9; k++) {
      const v = k * step, y = p.t + (H - p.t - p.b) * (1 - (v - lo) / (hi - lo));
      svg.appendChild(C.S('line', { x1: p.l, x2: W - p.r, y1: y, y2: y, class: 'gridline' }));
      const t = C.S('text', { x: p.l - 8, y: y + 3, 'text-anchor': 'end', class: 'axis' }); t.textContent = label(Math.abs(v) < step * 1e-9 ? 0 : v); svg.appendChild(t);
    }
    const x = i => p.l + (W - p.l - p.r) * (i / Math.max(1, dates.length - 1));
    dateTicks(dates.length, W - p.l - p.r).forEach((i, k, all) => {
      const t = C.S('text', { x: x(i), y: H - 7, 'text-anchor': k === 0 ? 'start' : k === all.length - 1 ? 'end' : 'middle', class: 'axis' });
      t.textContent = dates.length <= 60 ? dates[i] : dates[i].slice(0, 7); svg.appendChild(t);
    });
    return x;
  }
  function clipGroup(svg, id, W, H, p) {
    const defs = C.S('defs', {}), clip = C.S('clipPath', { id: id + 'Clip' });
    clip.appendChild(C.S('rect', { x: p.l, y: p.t, width: W - p.l - p.r, height: H - p.t - p.b }));
    defs.appendChild(clip); svg.appendChild(defs);
    const group = C.S('g', { 'clip-path': 'url(#' + id + 'Clip)' }); svg.appendChild(group); return group;
  }
  function unverifiedMarks(group, statuses, x, H, p) {
    statuses.forEach((status, i) => {
      if (status === 'U') group.appendChild(C.S('line', { x1: x(i), x2: x(i), y1: p.t, y2: H - p.b, class: 'gap-line' }));
    });
  }
  function drawAggregate(view) {
    const svg = $('marginAggChart'), { W, H, p } = canvas(svg, 480);
    svg.replaceChildren();
    const series = aggregateSeries();
    const dates = M.dates.slice(view.start, view.end), statuses = M.status.slice(view.start, view.end);
    const raw = series.raw.slice(view.start, view.end), smoothed = series.smoothed.slice(view.start, view.end);
    const index = state.view === 'index';
    const [lo, hi] = C.domain([...(state.agg.raw ? raw : []), ...smoothed, ...(index ? [100] : [])], { includeZero: !index });
    const x = axes(svg, W, H, p, lo, hi, index ? 1 : 1e9, dates);
    const y = v => p.t + (H - p.t - p.b) * (1 - (v - lo) / (hi - lo));
    const unit = C.S('text', { x: 4, y: 13, class: 'axis axis-unit' }); unit.textContent = index ? 'Index (base = 100)' : 'IDR billion'; svg.appendChild(unit);
    if (index && 100 >= lo && 100 <= hi) svg.appendChild(C.S('line', { x1: p.l, x2: W - p.r, y1: y(100), y2: y(100), class: 'reference-line' }));
    const group = clipGroup(svg, 'marginAggChart', W, H, p);
    unverifiedMarks(group, statuses, x, H, p);
    if (state.agg.raw) group.appendChild(C.S('path', { d: C.linePath(raw, x, y), class: 'line raw margin-raw' }));
    group.appendChild(C.S('path', { d: C.linePath(smoothed, x, y), class: 'line margin-smooth' }));
    const baseAt = dates.indexOf(state.base);
    if (index && baseAt >= 0) svg.appendChild(C.S('circle', { cx: x(baseAt), cy: y(100), r: 4, class: 'base-marker' }));
    svg.appendChild(C.S('rect', { x: p.l, y: p.t, width: W - p.l - p.r, height: H - p.t - p.b, fill: 'transparent', class: 'plot-hit-area' }));
    const label = state.agg.type + state.agg.n;
    svg.setAttribute('aria-label', (index ? 'Margin activity index, base ' + state.base + ' = 100' : 'Daily Margin value in IDR') +
      '. Drag to move dates, scroll or plus/minus to zoom, Box zoom to select a period, Home to reset.');
    return { W, H, p, tooltip: i => {
      const g = view.start + i;
      if (M.status[g] === 'U') return M.dates[g] + ' | Session not verified: no file was accepted for this date (a gap, not zero).';
      const total = M.total_value[g];
      return M.dates[g] + ' | ' + (index ? 'Index ' + series.raw[g].toFixed(2) + ' (base ' + state.base + ' = 100)'
        : 'Daily Margin value ' + fmtBn(total) + ' (' + fmtIdr(total) + ')') + ' | ' + label + ' ' +
        (finite(series.smoothed[g]) ? (index ? series.smoothed[g].toFixed(2) : fmtBn(series.smoothed[g])) : 'insufficient history') +
        ' | ' + M.records[g] + ' stocks with Margin records';
    } };
  }
  function syncAggregateNotes() {
    const index = state.view === 'index', series = aggregateSeries(), view = charts.agg.view();
    set('marginAggTitle', index ? 'Margin activity index (base ' + state.base + ' = 100)' : 'Daily Margin value (IDR)');
    const visible = series.smoothed.slice(view.start, view.end).filter(finite).length;
    set('marginAggNote', 'Source: IDX daily stock summary, Margin section · as of ' + M.meta.latest_date + ' · ' +
      (index ? 'Activity index = 100 × daily total ÷ total of ' + state.base + ' (a transaction-activity index, not a price return). '
        : 'Daily nominal total = sum of reported Nilai of all verified records (IDR); not outstanding margin debt. ') +
      state.agg.type + state.agg.n + ' over observed sessions, computed on the full history before zooming' +
      (visible ? '.' : ' — insufficient history in this window.') +
      (M.meta.unverified_sessions ? ' Dashed lines mark sessions without a verified file.' : ''));
    document.querySelectorAll('.margin-view').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
    $('marginBaseGroup').hidden = !index;
    set('marginBaseNow', state.base);
  }

  /* ------------------------------------------------------------------------------------------------- tables */

  function dailyRows() {
    const i = M.dates.indexOf(state.daily.date);
    if (i < 0 || M.status[i] !== 'V') return [];
    const total = M.total_value[i], rows = [];
    for (let r = M.offsets[i]; r < M.offsets[i + 1]; r++) {
      rows.push({ date: M.dates[i], code: M.codes[M.code[r]], value: M.value[r], share: 100 * M.value[r] / total,
                  volume: M.volume[r], frequency: M.frequency[r], average: M.frequency[r] ? M.value[r] / M.frequency[r] : null });
    }
    return rows;
  }
  function periodRows() {
    const a = indexOfDate(state.period.start), b = verifiedIndexAtOrBefore(state.period.end);
    if (b < a) return { rows: [], sessions: 0, total: 0 };
    const sums = new Map();
    let total = 0, sessions = 0;
    for (let i = a; i <= b; i++) {
      if (M.status[i] !== 'V') continue;
      sessions += 1;
      for (let r = M.offsets[i]; r < M.offsets[i + 1]; r++) {
        const item = sums.get(M.code[r]) || { value: 0, observations: 0 };
        item.value += M.value[r]; item.observations += 1; sums.set(M.code[r], item); total += M.value[r];
      }
    }
    const rows = [...sums.entries()].map(([c, item]) => ({ start: state.period.start, end: state.period.end, code: M.codes[c],
      value: item.value, share: total ? 100 * item.value / total : null, observations: item.observations, sessions,
      absent: sessions - item.observations, average: item.value / item.observations }));
    return { rows, sessions, total };
  }
  function sortRows(rows, spec) {
    return rows.slice().sort((a, b) => {
      const x = a[spec.key], y = b[spec.key];
      if (x === y) return a.code < b.code ? -1 : 1;
      if (x === null) return 1; if (y === null) return -1;
      return (x < y ? -1 : 1) * spec.dir;
    });
  }
  function renderTable(tableId, columns, rows, spec, onSort) {
    const table = $(tableId), head = el('tr'), body = el('tbody');
    columns.forEach(column => {
      const sorted = spec.key === column.key;
      const th = el('th', { scope: 'col', 'aria-sort': sorted ? (spec.dir < 0 ? 'descending' : 'ascending') : 'none',
                            class: column.numeric ? 'num' : '' });
      if (column.sortable === false) th.textContent = column.label;
      else {
        const button = el('button', { type: 'button', class: 'sort-button', text: column.label + (sorted ? (spec.dir < 0 ? ' ↓' : ' ↑') : '') });
        button.addEventListener('click', () => onSort(column.key)); th.appendChild(button);
      }
      head.appendChild(th);
    });
    rows.forEach(row => {
      const tr = el('tr', { 'data-code': row.code });
      if (row.code === state.code) tr.classList.add('selected');
      columns.forEach(column => {
        const td = el('td', { class: column.numeric ? 'num' : '' });
        if (column.key === 'code') {
          const button = el('button', { type: 'button', class: 'code-button', text: row.code, 'aria-label': 'Show ' + row.code + ' Margin history' });
          button.addEventListener('click', () => selectStock(row.code, true)); td.appendChild(button);
        } else td.textContent = column.format(row[column.key]);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.replaceChildren(el('thead', {}, [head]), body);
  }
  const DAILY_COLUMNS = [
    { key: 'date', label: 'Trade Date', format: v => v, sortable: false },
    { key: 'code', label: 'Stock Code', format: v => v },
    { key: 'value', label: 'Margin Value (IDR)', format: fmtInt, numeric: true },
    { key: 'share', label: 'Share of Day', format: fmtPct, numeric: true },
    { key: 'volume', label: 'Volume (shares)', format: fmtInt, numeric: true },
    { key: 'frequency', label: 'Frequency (trades)', format: fmtInt, numeric: true },
    { key: 'average', label: 'Avg Value per Trade (IDR)', format: fmtInt, numeric: true },
  ];
  const PERIOD_COLUMNS = [
    { key: 'start', label: 'Period Start', format: v => v, sortable: false },
    { key: 'end', label: 'Period End', format: v => v, sortable: false },
    { key: 'code', label: 'Stock Code', format: v => v },
    { key: 'value', label: 'Period Value (IDR)', format: fmtInt, numeric: true },
    { key: 'share', label: 'Share of Period Total', format: fmtPct, numeric: true },
    { key: 'observations', label: 'Observations', format: fmtInt, numeric: true },
    { key: 'sessions', label: 'Verified Sessions', format: fmtInt, numeric: true },
    { key: 'absent', label: 'Sessions Without Record', format: fmtInt, numeric: true },
    { key: 'average', label: 'Avg Value per Observation (IDR)', format: fmtInt, numeric: true },
  ];
  function renderDaily() {
    const all = dailyRows(), filter = state.daily.filter;
    const rows = sortRows(all.filter(row => !filter || row.code.includes(filter)), state.daily);
    renderTable('marginDailyTable', DAILY_COLUMNS, rows, state.daily, key => {
      state.daily.dir = state.daily.key === key ? -state.daily.dir : (key === 'code' ? 1 : -1); state.daily.key = key; renderDaily();
    });
    const i = M.dates.indexOf(state.daily.date);
    set('marginDailySummary', all.length ? all.length + ' stocks had Margin records on ' + state.daily.date + ' · total ' +
      fmtBn(M.total_value[i]) + ' (' + fmtIdr(M.total_value[i]) + ')' + (filter ? ' · ' + rows.length + ' shown' : '') +
      '. Stocks without a record that day are not listed; that is not a zero.' : 'No verified Margin file for ' + state.daily.date + '.');
    $('marginDailyDate').value = state.daily.date;
  }
  function renderPeriod() {
    const result = periodRows(), filter = state.period.filter;
    const rows = sortRows(result.rows.filter(row => !filter || row.code.includes(filter)), state.period);
    renderTable('marginPeriodTable', PERIOD_COLUMNS, rows, state.period, key => {
      state.period.dir = state.period.key === key ? -state.period.dir : (key === 'code' ? 1 : -1); state.period.key = key; renderPeriod();
    });
    set('marginPeriodSummary', result.sessions ? 'Period ' + state.period.start + ' → ' + state.period.end + ': ' + result.sessions +
      ' verified sessions, ' + result.rows.length + ' stocks, cumulative transaction value ' + fmtBn(result.total) + ' (' +
      fmtIdr(result.total) + '). This is a sum of daily transaction values, not a balance.' + (filter ? ' ' + rows.length + ' shown.' : '')
      : 'No verified Margin session in ' + state.period.start + ' → ' + state.period.end + '.');
    $('marginPeriodStart').value = state.period.start; $('marginPeriodEnd').value = state.period.end;
  }

  /* ------------------------------------------------------------------------------------------- stock chart */

  function stockSeries() {
    const c = codeIndex.get(state.code), values = new Array(M.dates.length).fill(null);
    if (c === undefined) return { values, smoothed: values };
    const entry = stockIndex[c];
    entry.dates.forEach((i, k) => { values[i] = M.value[entry.records[k]]; });
    return { values, smoothed: C.movingAverage(values, state.stock.n, state.stock.type, state.stock.basis) };
  }
  function drawStock(view) {
    const svg = $('marginStockChart'), { W, H, p } = canvas(svg, 480);
    svg.replaceChildren();
    const series = stockSeries();
    const dates = M.dates.slice(view.start, view.end), statuses = M.status.slice(view.start, view.end);
    const values = series.values.slice(view.start, view.end), smoothed = series.smoothed.slice(view.start, view.end);
    const [lo, hi] = C.domain([...values, ...smoothed], { includeZero: true });
    const x = axes(svg, W, H, p, lo, hi, 1e9, dates);
    const y = v => p.t + (H - p.t - p.b) * (1 - (v - lo) / (hi - lo));
    const unit = C.S('text', { x: 4, y: 13, class: 'axis axis-unit' }); unit.textContent = 'IDR billion'; svg.appendChild(unit);
    const group = clipGroup(svg, 'marginStockChart', W, H, p);
    unverifiedMarks(group, statuses, x, H, p);
    const width = Math.max(1, (W - p.l - p.r) / Math.max(1, dates.length) * 0.7);
    values.forEach((value, i) => {
      if (!finite(value)) return;
      group.appendChild(C.S('rect', { x: x(i) - width / 2, y: y(value), width, height: Math.max(0.5, y(lo) - y(value)), class: 'stock-bar' }));
    });
    group.appendChild(C.S('path', { d: C.linePath(smoothed, x, y), class: 'line margin-smooth' }));
    svg.appendChild(C.S('rect', { x: p.l, y: p.t, width: W - p.l - p.r, height: H - p.t - p.b, fill: 'transparent', class: 'plot-hit-area' }));
    const label = state.stock.type + state.stock.n + (state.stock.basis === 'observed' ? ' (observed records)' : ' (sessions)');
    return { W, H, p, tooltip: i => {
      const g = view.start + i;
      if (M.status[g] === 'U') return M.dates[g] + ' | Session not verified: no file was accepted for this date.';
      if (!finite(series.values[g])) return M.dates[g] + ' | ' + state.code + ': no Margin record on this verified session (not a zero).';
      const r = stockIndex[codeIndex.get(state.code)].records[stockIndex[codeIndex.get(state.code)].dates.indexOf(g)];
      return M.dates[g] + ' | ' + state.code + ' Margin value ' + fmtBn(series.values[g]) + ' (' + fmtIdr(series.values[g]) +
        ') | ' + label + ' ' + (finite(series.smoothed[g]) ? fmtBn(series.smoothed[g]) : 'insufficient history') +
        ' | volume ' + fmtInt(M.volume[r]) + ' shares, ' + fmtInt(M.frequency[r]) + ' trades';
    } };
  }
  function syncStockNotes() {
    const series = stockSeries(), view = charts.stock.view(), c = codeIndex.get(state.code);
    let observed = 0, absent = 0, unverified = 0, total = 0, latest = null;
    for (let i = view.start; i < view.end; i++) {
      if (M.status[i] === 'U') unverified += 1;
      else if (finite(series.values[i])) { observed += 1; total += series.values[i]; }
      else absent += 1;
    }
    if (c !== undefined) latest = M.dates[stockIndex[c].dates[stockIndex[c].dates.length - 1]];
    const maVisible = series.smoothed.slice(view.start, view.end).filter(finite).length;
    set('marginStockTitle', state.code + ' — daily Margin value (IDR)');
    set('marginStockStats', observed + ' sessions with a Margin record, ' + absent + ' verified sessions without one' +
      (unverified ? ', ' + unverified + ' unverified' : '') + ' in this window · window total ' + fmtBn(total) +
      ' · latest record ' + (latest || '—') + '.');
    set('marginStockNote', state.stock.type + state.stock.n + ' ' + (state.stock.basis === 'observed'
      ? 'over the stock’s last ' + state.stock.n + ' observed records (sessions without a record are skipped, never zero)'
      : 'over the last ' + state.stock.n + ' sessions; a session without a record breaks the window') +
      ', computed on the full history before zooming.' + (maVisible ? '' : ' Insufficient history for this average in the window.'));
  }
  function selectStock(code, scroll) {
    if (!codeIndex.has(code)) { set('marginStockError', 'Unknown stock code: ' + code); return false; }
    set('marginStockError', '');
    state.code = code; store.set('stock', code); $('marginStockCode').value = code;
    charts.stock.redraw(); syncStockNotes();
    document.querySelectorAll('#marginDailyTable tr, #marginPeriodTable tr').forEach(tr => tr.classList.toggle('selected', tr.dataset.code === code));
    if (scroll) $('marginStockCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try { history.replaceState(null, '', '#margin/' + code); } catch (e) { /* file:// */ }
    return true;
  }

  /* ----------------------------------------------------------------------------------------- data status */

  function renderStatus() {
    if (!ready) {
      set('smState', error ? (error === 'MARGIN_DATA_NOT_LOADED' ? 'Margin data could not be loaded; nothing is shown.'
        : 'Margin data failed validation (' + error + '); nothing is shown.') : 'Margin data not loaded yet.');
      ['smArchive', 'smAdded', 'smUpdate', 'smRecorded', 'smPending', 'smUnverified', 'smSuccess', 'smQc', 'smSnapshot',
       'smParticipation'].forEach(id => set(id, '—'));
      $('smUpdateChip').textContent = error ? 'NOT SHOWN' : 'LOADING'; $('smUpdateChip').dataset.status = error ? 'FAILED' : '';
      $('smMonthly').replaceChildren();
      return;
    }
    const meta = M.meta, update = meta.update, qc = meta.qc, archive = meta.archive;
    set('smState', meta.sessions + ' verified sessions, ' + meta.records.toLocaleString('en-US') + ' stock records, ' + meta.codes +
      ' stock codes, ' + meta.first_date + ' → ' + meta.latest_date + (meta.unverified_sessions ? '; ' + meta.unverified_sessions +
      ' expected sessions in this range have no verified file (gaps)' : '; no gaps') + '.');
    set('smArchive', archive.sessions + ' sessions, ' + archive.records.toLocaleString('en-US') + ' stock records, ' + archive.codes +
      ' stock codes, ' + archive.first_date + ' → ' + archive.last_date + ' (verified historical import).');
    const after = indexOfDate(archive.last_date) + (M.dates.includes(archive.last_date) ? 1 : 0);
    const added = M.status.slice(after).filter(s => s === 'V').length, addedRecords = M.offsets[M.dates.length] - M.offsets[after];
    set('smAdded', added ? added + ' sessions, ' + addedRecords.toLocaleString('en-US') + ' stock records after ' + archive.last_date + '.'
      : 'None yet: every session shown comes from the imported archive.');
    set('smUpdate', updateSentence(update));
    $('smUpdateChip').textContent = update.status; $('smUpdateChip').dataset.status = update.status;
    set('smRecorded', (update.recorded_at || '—') + (update.latest_expected_session ? ' · latest expected session at that time: ' + update.latest_expected_session : ''));
    set('smPending', update.pending_dates.length ? update.pending_dates.join(', ') : 'None');
    set('smUnverified', update.unverified_dates.length ? update.unverified_dates.join(', ') : 'None');
    set('smSuccess', update.last_success_at || 'No update run has added a session yet.');
    set('smQc', qc.sessions_pass + ' sessions PASS, ' + qc.sessions_pass_with_warnings + ' PASS with warnings (' + qc.warning_count +
      ' warnings). All nine original columns are verified and kept privately; the public file carries Stock Code, Nilai, Volume and Frequency. ' +
      'Date evidence: ' + qc.date_evidence + '. Sessions also matched to the same session’s All Stock price range: ' +
      qc.all_stock_cross_check.passed_sessions + ' of ' + qc.all_stock_cross_check.checked_sessions + ' checked.');
    set('smSnapshot', 'Revision ' + meta.snapshot.revision + ', generated ' + meta.snapshot.generated_at + ', content SHA-256 ' +
      meta.snapshot.content_sha256.slice(0, 16) + '…');
    const counts = M.records.filter(v => v !== null).sort((a, b) => a - b);
    set('smParticipation', counts.length ? 'Stocks with Margin records per verified session: min ' + counts[0] + ', median ' +
      counts[Math.floor(counts.length / 2)] + ', max ' + counts[counts.length - 1] + '; latest session ' + M.records[M.records.length - 1] +
      '. A stock without a record on a verified session had no Margin trades reported that day: dataset completeness counts sessions, not stocks.' : '—');
    const body = el('tbody');
    M.monthly.slice().reverse().forEach(item => {
      const tr = el('tr');
      [item.month, item.expected, item.verified, item.unverified, item.records.toLocaleString('en-US')].forEach((value, k) =>
        tr.appendChild(el('td', { class: k ? 'num' : '', text: String(value) })));
      if (item.unverified) tr.classList.add('warn');
      body.appendChild(tr);
    });
    $('smMonthly').replaceChildren(el('thead', {}, [el('tr', {}, ['Month', 'Expected sessions', 'Verified', 'Unverified or pending', 'Stock records']
      .map((label, k) => el('th', { scope: 'col', class: k ? 'num' : '', text: label })))]), body);
  }

  /* ------------------------------------------------------------------------------------------------ wiring */

  function readInt(input) { const n = Number(input.value); return Number.isInteger(n) && n >= 1 && n <= 1260 ? n : null; }
  function setDateBounds() {
    ['marginAggFrom', 'marginAggTo', 'marginDailyDate', 'marginPeriodStart', 'marginPeriodEnd', 'marginStockFrom', 'marginStockTo', 'marginBase']
      .forEach(id => { $(id).min = M.meta.first_date; $(id).max = M.meta.latest_date; });
  }
  function rangeControls(prefix, chart, presets) {
    function preset(name) {
      const end = M.dates.length; chart.apply(presetStart(end, name), end);
      document.querySelectorAll('.' + prefix + '-range').forEach(b => b.classList.toggle('active', b.dataset.range === name));
      $(prefix + 'From').value = M.dates[chart.view().start]; $(prefix + 'To').value = M.dates[chart.view().end - 1];
      after();
    }
    function after() { if (prefix === 'marginAgg') syncAggregateNotes(); else syncStockNotes(); }
    document.querySelectorAll('.' + prefix + '-range').forEach(button => button.addEventListener('click', () => preset(button.dataset.range)));
    $(prefix + 'Apply').addEventListener('click', () => {
      const from = $(prefix + 'From').value, to = $(prefix + 'To').value, message = $(prefix + 'RangeError');
      if (!DAY.test(from) || !DAY.test(to) || from > to) { message.textContent = 'Choose a start date on or before the end date.'; return; }
      const start = indexOfDate(from), end = Math.min(M.dates.length, indexOfDate(to) + (M.dates.includes(to) ? 1 : 0));
      if (end - start < 2) { message.textContent = 'The selected range has fewer than two sessions.'; return; }
      message.textContent = '';
      document.querySelectorAll('.' + prefix + '-range').forEach(b => b.classList.remove('active'));
      chart.apply(start, end); after();
    });
    return preset;
  }
  function unavailable(code, message) {
    error = code;
    $('marginLoading').hidden = true;
    $('marginError').textContent = message + ' Market Breadth is unaffected.';
    $('marginError').className = 'banner show'; $('marginContent').hidden = true;
    set('marginStatusLine', 'Margin data is not shown.'); $('marginStatusChip').textContent = 'NOT SHOWN'; $('marginStatusChip').dataset.status = 'FAILED';
    renderStatus();
  }
  function loadFailed() {
    if (ready || error) return;
    unavailable('MARGIN_DATA_NOT_LOADED', 'Margin data could not be loaded. Reload the page to try again.');
  }
  function init() {
    if (ready || error) return;
    try { M = validate(window.IHSG_MARGIN_DATA); }
    catch (e) {
      const code = String(e && e.message || 'MARGIN_INVALID').replace(/[^A-Z_]/g, '').slice(0, 40) || 'MARGIN_INVALID';
      unavailable(code, 'Margin data could not be shown: it failed validation (' + code + ').');
      return;
    }
    $('marginLoading').hidden = true; $('marginContent').hidden = false;      // charts measure their real size
    buildIndexes();
    state.base = M.meta.base_date;
    const latest = M.meta.latest_date;
    state.daily.date = latest;
    state.period.end = latest;
    state.period.start = M.dates[presetStart(M.dates.length, '1M')];
    const remembered = store.get('stock', null);
    const top = dailyRows().sort((a, b) => b.value - a.value)[0];
    state.code = remembered && codeIndex.has(remembered) ? remembered : top.code;
    const hashCode = (location.hash.match(/^#margin\/([A-Z0-9-]{1,16})$/) || [])[1];
    if (hashCode && codeIndex.has(hashCode)) state.code = hashCode;
    setDateBounds();
    $('marginBase').value = state.base; $('marginStockCode').value = state.code;
    const datalist = $('marginCodes'); datalist.replaceChildren(...M.codes.map(code => el('option', { value: code })));
    // charts
    charts.agg = C.create({ svg: $('marginAggChart'), tip: $('marginAggTip'), rangeLabel: $('marginAggRange'),
      boxButton: $('marginAggBox'), resetButton: $('marginAggReset'), dates: () => M.dates, minCount: 5,
      draw: view => { const scene = drawAggregate(view); setTimeout(syncAggregateNotes); return scene; } });
    charts.stock = C.create({ svg: $('marginStockChart'), tip: $('marginStockTip'), rangeLabel: $('marginStockRange'),
      boxButton: $('marginStockBox'), resetButton: $('marginStockReset'), dates: () => M.dates, minCount: 5,
      draw: view => { const scene = drawStock(view); setTimeout(syncStockNotes); return scene; } });
    const aggPreset = rangeControls('marginAgg', charts.agg);
    const stockPreset = rangeControls('marginStock', charts.stock);
    C.fullscreen($('marginAggCard'), $('marginAggExpand'), () => charts.agg.redraw());
    C.fullscreen($('marginStockCard'), $('marginStockExpand'), () => charts.stock.redraw());
    // aggregate controls
    document.querySelectorAll('.margin-view').forEach(button => button.addEventListener('click', () => {
      state.view = button.dataset.view; store.set('agg-view', state.view); charts.agg.redraw(); syncAggregateNotes();
    }));
    $('marginBaseApply').addEventListener('click', () => {
      const day = $('marginBase').value, i = M.dates.indexOf(day);
      if (i < 0 || M.status[i] !== 'V' || !(M.total_value[i] > 0)) {
        set('marginBaseError', 'The base must be a verified session with a positive total; ' + (day || 'no date') + ' is not.');
        $('marginBase').value = state.base; return;
      }
      set('marginBaseError', ''); state.base = day; $('marginBase').value = day; charts.agg.redraw(); syncAggregateNotes();
    });
    $('marginAggType').value = state.agg.type; $('marginAggN').value = state.agg.n; $('marginAggRaw').checked = state.agg.raw;
    $('marginAggSmooth').addEventListener('click', () => {
      const n = readInt($('marginAggN'));
      if (n === null) { set('marginAggSmoothError', 'Enter a whole number of sessions from 1 to 1260.'); return; }
      set('marginAggSmoothError', ''); state.agg.n = n; state.agg.type = $('marginAggType').value;
      store.set('agg-n', n); store.set('agg-type', state.agg.type); charts.agg.redraw(); syncAggregateNotes();
    });
    $('marginAggRaw').addEventListener('change', () => { state.agg.raw = $('marginAggRaw').checked; store.set('agg-raw', state.agg.raw ? '1' : '0'); charts.agg.redraw(); });
    // stock controls
    $('marginStockType').value = state.stock.type; $('marginStockN').value = state.stock.n; $('marginStockBasis').value = state.stock.basis;
    $('marginStockSmooth').addEventListener('click', () => {
      const n = readInt($('marginStockN'));
      if (n === null) { set('marginStockSmoothError', 'Enter a whole number of sessions from 1 to 1260.'); return; }
      set('marginStockSmoothError', ''); state.stock.n = n; state.stock.type = $('marginStockType').value; state.stock.basis = $('marginStockBasis').value;
      store.set('stock-n', n); store.set('stock-type', state.stock.type); store.set('stock-basis', state.stock.basis); charts.stock.redraw(); syncStockNotes();
    });
    $('marginStockGo').addEventListener('click', () => selectStock(String($('marginStockCode').value || '').trim().toUpperCase(), false));
    $('marginStockCode').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('marginStockGo').click(); } });
    $('marginStockPrev').addEventListener('click', () => { const i = codeIndex.get(state.code); selectStock(M.codes[(i - 1 + M.codes.length) % M.codes.length], false); });
    $('marginStockNext').addEventListener('click', () => { const i = codeIndex.get(state.code); selectStock(M.codes[(i + 1) % M.codes.length], false); });
    // tables
    $('marginDailyDate').addEventListener('change', () => {
      const day = $('marginDailyDate').value, i = M.dates.indexOf(day);
      if (i < 0 || M.status[i] !== 'V') { set('marginDailyError', (day || 'That date') + ' is not a verified Margin session; choose another date.'); $('marginDailyDate').value = state.daily.date; return; }
      set('marginDailyError', ''); state.daily.date = day; renderDaily();
    });
    function stepDaily(direction) {
      let i = M.dates.indexOf(state.daily.date) + direction;
      while (i >= 0 && i < M.dates.length && M.status[i] !== 'V') i += direction;
      if (i >= 0 && i < M.dates.length) { state.daily.date = M.dates[i]; set('marginDailyError', ''); renderDaily(); }
    }
    $('marginDailyPrev').addEventListener('click', () => stepDaily(-1));
    $('marginDailyNext').addEventListener('click', () => stepDaily(1));
    $('marginDailySearch').addEventListener('input', () => { state.daily.filter = $('marginDailySearch').value.trim().toUpperCase(); renderDaily(); });
    $('marginPeriodApply').addEventListener('click', () => {
      const start = $('marginPeriodStart').value, end = $('marginPeriodEnd').value;
      if (!DAY.test(start) || !DAY.test(end) || start > end) { set('marginPeriodError', 'Choose a start date on or before the end date.'); return; }
      set('marginPeriodError', ''); state.period.start = start; state.period.end = end; renderPeriod();
    });
    document.querySelectorAll('.margin-period-range').forEach(button => button.addEventListener('click', () => {
      state.period.end = M.meta.latest_date; state.period.start = M.dates[presetStart(M.dates.length, button.dataset.range)];
      set('marginPeriodError', ''); renderPeriod();
    }));
    $('marginPeriodSearch').addEventListener('input', () => { state.period.filter = $('marginPeriodSearch').value.trim().toUpperCase(); renderPeriod(); });
    // exports
    $('marginDailyCsv').addEventListener('click', () => {
      const rows = sortRows(dailyRows(), state.daily);
      download('ihsg-margin-daily-' + state.daily.date + '.csv', [...csvHeader('daily stock snapshot ' + state.daily.date),
        DAILY_COLUMNS.map(c => csvCell(c.label)).join(','), ...rows.map(r => [r.date, r.code, r.value, r.share.toFixed(6), r.volume, r.frequency,
          r.average === null ? '' : r.average.toFixed(2)].map(csvCell).join(','))]);
    });
    $('marginPeriodCsv').addEventListener('click', () => {
      const rows = sortRows(periodRows().rows, state.period);
      download('ihsg-margin-period-' + state.period.start + '_' + state.period.end + '.csv', [...csvHeader('period ' + state.period.start + ' to ' + state.period.end),
        PERIOD_COLUMNS.map(c => csvCell(c.label)).join(','), ...rows.map(r => [r.start, r.end, r.code, r.value, r.share === null ? '' : r.share.toFixed(6),
          r.observations, r.sessions, r.absent, r.average.toFixed(2)].map(csvCell).join(','))]);
    });
    $('marginStockCsv').addEventListener('click', () => {
      const c = codeIndex.get(state.code), entry = stockIndex[c], series = stockSeries();
      download('ihsg-margin-stock-' + state.code + '.csv', [...csvHeader('stock history ' + state.code + ' (' + state.stock.type + state.stock.n + ', ' + state.stock.basis + ' basis)'),
        ['Trade Date', 'Stock Code', 'Margin Value (IDR)', 'Volume (shares)', 'Frequency (trades)', state.stock.type + state.stock.n + ' (IDR)'].join(','),
        ...entry.dates.map((i, k) => [M.dates[i], state.code, M.value[entry.records[k]], M.volume[entry.records[k]], M.frequency[entry.records[k]],
          finite(series.smoothed[i]) ? series.smoothed[i].toFixed(2) : ''].map(csvCell).join(','))]);
    });
    $('marginAggCsv').addEventListener('click', () => {
      const series = aggregateSeries(), base = M.total_value[M.dates.indexOf(state.base)];
      download('ihsg-margin-aggregate.csv', [...csvHeader('daily aggregate (activity index base ' + state.base + ' = 100)'),
        ['Trade Date', 'Session Status', 'Daily Margin Value (IDR)', 'Activity Index (base ' + state.base + ')', 'Stocks with Records'].join(','),
        ...M.dates.map((day, i) => [day, M.status[i] === 'V' ? 'verified' : 'unverified', M.total_value[i] === null ? '' : M.total_value[i],
          M.total_value[i] === null ? '' : (100 * M.total_value[i] / base).toFixed(6), M.records[i] === null ? '' : M.records[i]].map(csvCell).join(','))]);
    });
    // first paint
    ready = true;
    const update = M.meta.update;
    set('marginStatusLine', 'Latest verified Margin session ' + M.meta.latest_date + ' · ' + M.meta.sessions + ' verified sessions since ' +
      M.meta.first_date + ' · ' + updateSentence(update));
    $('marginStatusChip').textContent = update.status; $('marginStatusChip').dataset.status = update.status;
    const last = M.dates.length - 1, totals = M.total_value;
    set('mkValue', fmtBn(totals[last])); set('mkValueSub', M.meta.latest_date + ' · ' + M.records[last] + ' stocks · transaction value, not margin debt');
    set('mkIndex', (100 * totals[last] / M.meta.base_value).toFixed(1));
    set('mkIndexSub', 'base ' + M.meta.base_date + ' = 100 · transaction activity, not a price return');
    const sma = C.movingAverage(totals, 20, 'SMA', 'observed')[last];
    set('mkSma', fmtBn(sma)); set('mkSmaSub', 'SMA20 of the daily value');
    set('mkSessions', M.meta.sessions.toLocaleString('en-US')); set('mkSessionsSub', M.meta.records.toLocaleString('en-US') + ' stock records');
    const rememberedRange = store.get('agg-range', '1Y');
    aggPreset(RANGES.includes(rememberedRange) ? rememberedRange : '1Y');
    stockPreset('ALL');
    renderDaily(); renderPeriod(); syncStockNotes(); renderStatus();
    document.querySelectorAll('.marginAgg-range').forEach(b => b.addEventListener('click', () => store.set('agg-range', b.dataset.range)));
    let pending = 0;
    window.addEventListener('resize', () => {
      if (pending) return;
      pending = requestAnimationFrame(() => { pending = 0; if ($('marginAggChart').getBoundingClientRect().width) redraw(); });
    });
  }
  function redraw() { if (ready) { charts.agg.redraw(); charts.stock.redraw(); } }

  window.IHSGMargin = Object.freeze({
    init, loadFailed, renderStatus, redraw,
    state: () => ({ ready, error }),
    test() {
      if (!ready) return { ready, error };
      const agg = aggregateSeries(), stock = stockSeries(), av = charts.agg.view(), sv = charts.stock.view();
      return { ready, error, base: state.base, view: state.view, code: state.code, agg: { start: av.start, end: av.end,
        dates: M.dates.slice(av.start, av.end), raw: agg.raw.slice(av.start, av.end), smoothed: agg.smoothed.slice(av.start, av.end),
        full: agg.smoothed.slice() }, stock: { start: sv.start, end: sv.end, dates: M.dates.slice(sv.start, sv.end),
        raw: stock.values.slice(sv.start, sv.end), smoothed: stock.smoothed.slice(sv.start, sv.end), full: stock.smoothed.slice() },
        daily: { ...state.daily }, period: { ...state.period }, aggMa: { ...state.agg }, stockMa: { ...state.stock } };
    },
  });
})();
