// OBJ Dashboard front end. Served from the robot; no external libraries (the robot's Wi-Fi has no internet).
(() => {
  'use strict';

  const API = '/objdash/api';
  const POLL_MS = 100;
  const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea', '#0891b2', '#db2777', '#65a30d'];
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,63}$/;
  // PNG exports always use light colors so they read well in documents and slides.
  const LIGHT = { bg: '#ffffff', text: '#1c2024', muted: '#646b75', grid: '#e6e8ec', axis: '#8a919b', border: '#dfe2e7' };

  const $ = (id) => document.getElementById(id);

  // ---- storage (browser storage can be unavailable; never let it break the page) ----------------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
  };

  // ---- state ------------------------------------------------------------------------------------
  // A run record is also the saved-file format.
  function emptyRun(meta) {
    return {
      format: 'objdash-run', version: 1,
      run: meta.run || '', opMode: meta.opMode || '', state: meta.state || 'idle',
      startedAt: meta.startedAt || Date.now(), seq: 0,
      timeZero: 0, // seconds after INIT that the stored times are measured from (START, once pressed)
      values: {}, series: {},
    };
  }

  let live = store.get('objdash.live', null);
  if (!live || live.format !== 'objdash-run' || !live.series) live = emptyRun({});
  let viewing = null;                       // { folder, name, data } when looking at a saved run
  let selected = store.get('objdash.selected', []);
  let colorOf = store.get('objdash.colors', {});
  let windowSec = store.get('objdash.window', 30);
  let pausedEnd = null;                     // end time frozen by Pause
  let lastOk = 0;
  let liveDirty = false;
  let hoverX = null;
  let zoom = null;                          // { start, end } in seconds when zoomed in by dragging
  let drag = null;                          // { x0, x1 } canvas x while dragging out a zoom
  let chartGeom = null;                     // { plot, range } from the last on-screen draw
  let pick = null;                          // { start, end } seconds: a dragged-out span awaiting a choice
  let analyses = [];                        // statistics / regression results shown beside the graph
  let hoverAnalysis = null;                 // id of the result card under the mouse

  let robot = { state: 'idle', opMode: '' }; // live robot status from the last poll

  const current = () => (viewing ? viewing.data : live);

  // ---- polling ----------------------------------------------------------------------------------
  async function poll() {
    let delay = POLL_MS;
    try {
      const r = await fetch(`${API}/telemetry?run=${encodeURIComponent(live.run)}&since=${live.seq}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      lastOk = Date.now();
      ingest(d);
      if (d.more) delay = 0;
    } catch (e) {
      delay = 1000;
    }
    updateStatus();
    setTimeout(poll, delay);
  }

  function ingest(d) {
    // What the robot is doing right now (independent of which run the graph is showing).
    if (robot.state !== d.state || robot.opMode !== d.opMode) {
      const freshInit = d.state === 'init' && robot.state !== 'init';
      robot = { state: d.state, opMode: d.opMode };
      renderOpControls();
      refreshScan(freshInit);
    }
    // A freshly started robot with no OpMode yet: keep showing the run we already have (for example
    // one restored from browser storage after a power cycle) until there's something new.
    const robotIdle = d.run === 'idle' && !d.samples.length && !Object.keys(d.values).length;
    if (robotIdle && live.run !== 'idle' && live.seq > 0) return;
    // New OpMode run, or the robot app restarted (its sample count went backwards).
    if (d.run !== live.run || d.from < live.seq) {
      live = emptyRun(d);
      if (!viewing) { pausedEnd = null; if (zoom) setZoom(null); clearAnalyses(); }
      liveDirty = true;
    }
    if (live.opMode !== d.opMode || live.state !== d.state) liveDirty = true;
    live.opMode = d.opMode;
    live.state = d.state;
    live.startedAt = d.startedAt;
    live.values = d.values;
    if (JSON.stringify(live.colors || {}) !== JSON.stringify(d.colors || {})) { live.colors = d.colors || {}; liveDirty = true; }
    // Time 0 is when START is pressed. When that happens, shift what we already have (the INIT
    // period ends up at negative times).
    if (d.startOffset != null && d.startOffset !== live.timeZero) {
      const shift = d.startOffset - (live.timeZero || 0);
      for (const s of Object.values(live.series)) for (let i = 0; i < s.t.length; i++) s.t[i] = +(s.t[i] - shift).toFixed(4);
      live.timeZero = d.startOffset;
      if (pausedEnd != null && !viewing) pausedEnd -= shift;
      liveDirty = true;
    }
    for (const [t, ki, v] of d.samples) {
      const key = d.keys[ki];
      const s = live.series[key] || (live.series[key] = { t: [], v: [] });
      s.t.push(+(t - (live.timeZero || 0)).toFixed(4));
      s.v.push(v);
    }
    if (d.samples.length) liveDirty = true;
    live.seq = d.seq;
    rememberKeys(live);
    if (!viewing) {
      renderTable();
      requestDraw();
    }
  }

  // Keep the live run in the browser so a refresh doesn't lose it.
  function persistLive() {
    if (!liveDirty) return;
    liveDirty = false;
    const ok = store.set('objdash.live', live);
    if (!ok) store.remove('objdash.live'); // don't leave an older run behind
    $('storage-warning').hidden = ok;
  }
  setInterval(persistLive, 3000);
  window.addEventListener('pagehide', persistLive);

  // ---- status bar -------------------------------------------------------------------------------
  function updateStatus() {
    const ok = Date.now() - lastOk < 1500;
    $('conn').className = 'pill ' + (ok ? 'pill-good' : 'pill-bad');
    $('conn-text').textContent = ok ? 'Connected' : (lastOk ? 'Disconnected, retrying…' : 'Connecting…');
    $('opmode').textContent = robot.opMode || 'No OpMode yet';
    const st = $('opstate');
    st.textContent = robot.state;
    st.className = 'pill ' + (robot.state === 'running' ? 'pill-run' : 'pill-muted');
  }
  setInterval(updateStatus, 500);

  // ---- OpMode control ---------------------------------------------------------------------------
  const FLAVOR_LABEL = { AUTONOMOUS: 'Autonomous', TELEOP: 'TeleOp', UTILITY: 'Utility' };
  let driverStation = false;
  let opBusy = false;
  let mainLockedUntil = 0;

  async function loadOpModes() {
    try {
      const d = await getJson(`${API}/opmodes`);
      driverStation = d.driverStation;
      const sel = $('op-select');
      const want = sel.value || store.get('objdash.opmode', '');
      const sig = JSON.stringify(d.opModes);
      if (sel.dataset.sig !== sig) {
        sel.dataset.sig = sig;
        const groups = new Map();
        for (const op of d.opModes) {
          const label = FLAVOR_LABEL[op.flavor] || op.flavor;
          if (!groups.has(label)) {
            const g = document.createElement('optgroup');
            g.label = label;
            groups.set(label, g);
          }
          const o = document.createElement('option');
          o.value = op.name;
          o.textContent = op.group ? `${op.group} / ${op.name}` : op.name;
          groups.get(label).appendChild(o);
        }
        sel.replaceChildren(...groups.values());
        if (!d.opModes.length) {
          const o = document.createElement('option');
          o.textContent = 'No OpModes found';
          o.value = '';
          sel.appendChild(o);
        }
        if ([...sel.options].some((o) => o.value === want)) sel.value = want;
      }
      renderOpControls();
      refreshScan();
    } catch (e) { /* robot unreachable; the connection pill already says so */ }
  }

  function renderOpControls() {
    const state = robot.state;
    const active = state === 'init' || state === 'running';
    $('op-select').disabled = active;
    if (active && robot.opMode && [...$('op-select').options].some((o) => o.value === robot.opMode)) {
      $('op-select').value = robot.opMode;
    }
    // One main button that changes in place like the Driver Station's: INIT -> START -> STOP,
    // plus a small stop button during INIT.
    const main = $('op-main');
    const mode = state === 'init' ? 'start' : state === 'running' ? 'stop' : 'init';
    if (main.dataset.mode !== mode) {
      main.dataset.mode = mode;
      // Brief lockout after the button changes, so a double-click on INIT can't also press START.
      mainLockedUntil = Date.now() + 500;
      setTimeout(renderOpControls, 520);
    }
    main.textContent = mode === 'init' ? 'INIT' : mode === 'start' ? '▶ START' : '■ STOP';
    main.className = 'btn op-main ' + (mode === 'init' ? 'btn-primary' : mode === 'start' ? 'btn-go' : 'btn-stop');
    main.disabled = opBusy || Date.now() < mainLockedUntil || (mode === 'init' && !$('op-select').value);
    $('op-cancel').hidden = mode !== 'start';
    $('op-cancel').disabled = opBusy;
    $('op-space').hidden = !active;
    const hint = $('op-hint');
    hint.hidden = driverStation;
    hint.textContent = 'No Driver Station connected';
  }

  async function opAction(action, params) {
    opBusy = true;
    renderOpControls();
    try {
      const r = await fetch(`${API}/opmode/${action}${params || ''}`, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) toast(d.error || `Couldn't ${action}: HTTP ${r.status}`);
    } catch (e) {
      toast(`Couldn't reach the robot to ${action}.`);
    } finally {
      opBusy = false;
      renderOpControls();
      loadOpModes();
    }
  }

  $('op-select').addEventListener('change', () => { store.set('objdash.opmode', $('op-select').value); renderOpControls(); refreshScan(); });

  // ---- expected telemetry, shown before data arrives ---------------------------------------------
  // Two sources, merged: (1) the robot reads the OpMode's OnBot Java source, and the classes it
  // uses, for ObjDash.put("name", ...); (2) names this OpMode actually sent in earlier runs, which
  // catches names built in code. Rows for names with no data yet show "–" but can be checked.
  let scan = { opMode: null, keys: [], classes: [] };
  let scanFor = null;
  const remembered = {}; // opMode -> { key: numeric (true/false) }

  function targetOpMode() {
    if (viewing) return '';
    if (robot.state === 'init' || robot.state === 'running') return robot.opMode || '';
    return $('op-select').value || '';
  }

  function getRemembered(op) {
    if (!(op in remembered)) remembered[op] = store.get(`objdash.keys.${op}`, {}) || {};
    return remembered[op];
  }

  function rememberKeys(run) {
    if (!run.opMode) return;
    const mem = getRemembered(run.opMode);
    let changed = false;
    for (const k of Object.keys(run.series)) if (mem[k] !== true) { mem[k] = true; changed = true; }
    for (const k of Object.keys(run.values)) if (!(k in mem)) { mem[k] = !!run.series[k]; changed = true; }
    if (changed) store.set(`objdash.keys.${run.opMode}`, mem);
  }

  async function refreshScan(force) {
    const op = targetOpMode();
    if (!op) {
      if (scan.opMode !== null) { scan = { opMode: null, keys: [], classes: [] }; scanFor = null; renderTable(); rerenderConfig(); }
      return;
    }
    if (!force && op === scanFor) return;
    scanFor = op;
    let result = { opMode: op, keys: [], classes: [] };
    try {
      const d = await getJson(`${API}/opmode/keys?name=${encodeURIComponent(op)}`);
      result = { opMode: op, keys: d.keys || [], classes: d.classes || [], ok: !d.note };
    } catch (e) { /* fall back to remembered names only */ }
    if (op !== scanFor) return; // a newer request replaced this one
    scan = result;
    renderTable();
    rerenderConfig();
  }

  /** key -> true (number), false (text) or undefined (not known yet), in display order. */
  function expectedKeys() {
    const op = targetOpMode();
    const out = new Map();
    if (!op) return out;
    if (scan.opMode === op) for (const k of scan.keys) out.set(k, undefined);
    const mem = getRemembered(op);
    for (const k of Object.keys(mem)) out.set(k, mem[k]);
    return out;
  }
  $('op-select').addEventListener('focus', loadOpModes); // pick up OpModes added by an OnBot Java build
  $('op-main').addEventListener('click', () => {
    const mode = $('op-main').dataset.mode;
    if (mode === 'init') opAction('init', `?name=${encodeURIComponent($('op-select').value)}`);
    else if (mode === 'start') opAction('start');
    else opAction('stop');
  });
  $('op-cancel').addEventListener('click', () => opAction('stop'));

  // SPACE stops the OpMode from anywhere on the page, except while typing in a text box. Handled in
  // the capture phase and default-prevented so a focused button (like Start) can't also be pressed.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    const t = e.target;
    const typing = t && (t.isContentEditable || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes(t.type)) || t.tagName === 'TEXTAREA');
    if (typing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    if (robot.state === 'init' || robot.state === 'running') opAction('stop');
  }, true);
  setInterval(loadOpModes, 3000); // keeps the Driver Station status current

  // ---- telemetry table --------------------------------------------------------------------------
  const rows = new Map(); // key -> { tr, val, cb, sw }

  const validColor = (c) => typeof c === 'string' && c.length <= 40 && window.CSS && CSS.supports('color', c);

  /**
   * Colors for the graphed keys, decided together so no two lines share a color.
   * 1. A color set in code with ObjDash.put(key, value, color) always wins.
   * 2. Otherwise a key keeps the color it had before, unless another line already has it.
   * 3. Otherwise it gets the first palette color not in use.
   */
  function resolveColors(run, keys) {
    const out = {};
    const used = new Set();
    const explicit = run.colors || {};
    for (const k of keys) {
      if (validColor(explicit[k])) { out[k] = explicit[k]; used.add(explicit[k].toLowerCase()); }
    }
    let changed = false;
    for (const k of keys) {
      if (out[k]) continue;
      let c = colorOf[k];
      if (!c || used.has(c.toLowerCase())) {
        c = COLORS.find((p) => !used.has(p)) || COLORS[used.size % COLORS.length];
        if (colorOf[k] !== c) { colorOf[k] = c; changed = true; }
      }
      out[k] = c;
      used.add(c.toLowerCase());
    }
    if (changed) store.set('objdash.colors', colorOf);
    return out;
  }

  function renderTable() {
    const run = current();
    const filter = $('filter').value.trim().toLowerCase();
    const keys = Object.keys(run.values);
    for (const k of Object.keys(run.series)) if (!(k in run.values)) keys.push(k);
    const expected = viewing ? new Map() : expectedKeys();
    const present = new Set(keys);
    for (const k of expected.keys()) if (!present.has(k)) keys.push(k);
    const tbody = $('tbody');
    const seen = new Set();
    const colors = resolveColors(run, visibleKeys(run));

    keys.forEach((key, i) => {
      seen.add(key);
      let row = rows.get(key);
      if (!row) {
        const tr = document.createElement('tr');
        const tdCb = document.createElement('td'); tdCb.className = 'cb';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.title = 'Graph this value';
        cb.addEventListener('change', () => toggleKey(key, cb.checked));
        tdCb.appendChild(cb);
        const tdKey = document.createElement('td'); tdKey.className = 'key'; tdKey.title = key;
        const sw = document.createElement('span'); sw.className = 'swatch';
        tdKey.append(sw, document.createTextNode(key));
        tdKey.addEventListener('click', () => { if (!cb.disabled) { cb.checked = !cb.checked; toggleKey(key, cb.checked); } });
        const val = document.createElement('td'); val.className = 'val';
        tr.append(tdCb, tdKey, val);
        row = { tr, val, cb, sw };
        rows.set(key, row);
      }
      const pending = !(key in run.values) && !run.series[key];
      // Graphable if it has numbers, or (no data yet) unless it's known to be text.
      const numeric = !!run.series[key] || (pending && expected.get(key) !== false);
      const text = pending ? '–' : key in run.values ? run.values[key] : '';
      row.tr.classList.toggle('pending', pending);
      row.tr.title = pending ? 'No data yet in this run' : '';
      if (row.val.textContent !== text) { row.val.textContent = text; row.val.title = text; }
      row.cb.disabled = !numeric;
      row.cb.checked = numeric && selected.includes(key);
      row.sw.style.background = (row.cb.checked && colors[key]) || 'transparent';
      row.tr.hidden = !!filter && !key.toLowerCase().includes(filter);
      if (tbody.children[i] !== row.tr) tbody.insertBefore(row.tr, tbody.children[i] || null);
    });

    for (const [key, row] of rows) {
      if (!seen.has(key)) { row.tr.remove(); rows.delete(key); }
    }
    $('empty').hidden = keys.length > 0;
  }

  function toggleKey(key, on) {
    selected = selected.filter((k) => k !== key);
    if (on) selected.push(key);
    store.set('objdash.selected', selected);
    renderTable();
    requestDraw();
  }

  $('filter').addEventListener('input', renderTable);

  // ---- chart ------------------------------------------------------------------------------------
  function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function niceStep(span, count) {
    const raw = span / Math.max(1, count);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }

  function ticks(min, max, count) {
    const step = niceStep(max - min, count);
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
    const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));
    return { values: out, fmt: (v) => v.toFixed(decimals) };
  }

  function fmtValue(v) {
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(1) : a >= 1 ? v.toFixed(3) : v.toPrecision(3);
  }

  function visibleKeys(run) {
    return selected.filter((k) => run.series[k] && run.series[k].t.length);
  }

  function timeRange(run, keys) {
    let minT = Infinity, maxT = -Infinity;
    for (const k of keys) {
      const t = run.series[k].t;
      minT = Math.min(minT, t[0]);
      maxT = Math.max(maxT, t[t.length - 1]);
    }
    if (!isFinite(minT)) return null;
    if (zoom) return { start: zoom.start, end: zoom.end };
    let end = pausedEnd != null ? pausedEnd : maxT;
    let start;
    if (windowSec > 0) {
      start = Math.max(Math.min(minT, 0), end - windowSec);
      end = start + windowSec;
    } else {
      start = minT;
    }
    if (end - start < 1e-6) { start -= 0.5; end += 0.5; }
    return { start, end };
  }

  function themeColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return { bg: v('--chart-bg'), text: v('--text'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'), border: v('--border') };
  }

  /**
   * Draws the chart into ctx (already scaled to CSS pixels). Used for both the screen and PNG export.
   * opts: { hoverX, title, subtitle, legend }
   */
  function renderChart(ctx, w, h, run, keys, range, th, opts) {
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, w, h);
    if (!range || !keys.length) return;
    const colors = resolveColors(run, keys);

    let top = 10;
    ctx.textBaseline = 'alphabetic';
    if (opts.title) {
      ctx.fillStyle = th.text;
      ctx.font = '600 20px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.fillText(opts.title, 20, 34);
      top = 46;
      if (opts.subtitle) {
        ctx.fillStyle = th.muted;
        ctx.font = '13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        ctx.fillText(opts.subtitle, 20, 56);
        top = 68;
      }
    }
    if (opts.legend) {
      ctx.font = '13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      let x = 20;
      const y = top + 12;
      for (const k of keys) {
        const wText = ctx.measureText(k).width;
        if (x + wText + 30 > w - 20) break;
        ctx.fillStyle = colors[k];
        ctx.fillRect(x, y - 9, 12, 3);
        ctx.fillStyle = th.text;
        ctx.fillText(k, x + 18, y - 3);
        x += wText + 36;
      }
      top += 24;
    }

    const plot = { l: 60, r: w - 14, t: top + 6, b: h - 30 };
    const pw = plot.r - plot.l, ph = plot.b - plot.t;
    if (pw < 20 || ph < 20) return;

    // Index ranges and y extent of what's on screen.
    let yMin = Infinity, yMax = -Infinity;
    const spans = keys.map((k) => {
      const s = run.series[k];
      const i0 = Math.max(0, lowerBound(s.t, range.start) - 1);
      const i1 = Math.min(s.t.length, lowerBound(s.t, range.end) + 1);
      for (let i = i0; i < i1; i++) { const v = s.v[i]; if (v < yMin) yMin = v; if (v > yMax) yMax = v; }
      return { k, s, i0, i1 };
    });
    if (!isFinite(yMin)) { yMin = -1; yMax = 1; }
    if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.06;
    yMin -= pad; yMax += pad;

    const xOf = (t) => plot.l + ((t - range.start) / (range.end - range.start)) * pw;
    const yOf = (v) => plot.b - ((v - yMin) / (yMax - yMin)) * ph;

    // Grid and axis labels.
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.lineWidth = 1;
    const yt = ticks(yMin, yMax, Math.max(2, Math.floor(ph / 45)));
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of yt.values) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = th.grid;
      ctx.beginPath(); ctx.moveTo(plot.l, y); ctx.lineTo(plot.r, y); ctx.stroke();
      ctx.fillStyle = th.muted;
      ctx.fillText(yt.fmt(v), plot.l - 6, y);
    }
    const xt = ticks(range.start, range.end, Math.max(2, Math.floor(pw / 90)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of xt.values) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.strokeStyle = th.grid;
      ctx.beginPath(); ctx.moveTo(x, plot.t); ctx.lineTo(x, plot.b); ctx.stroke();
      ctx.fillStyle = th.muted;
      ctx.fillText(xt.fmt(t) + 's', x, plot.b + 6);
    }
    ctx.strokeStyle = th.axis;
    ctx.beginPath(); ctx.moveTo(plot.l + 0.5, plot.t); ctx.lineTo(plot.l + 0.5, plot.b + 0.5); ctx.lineTo(plot.r, plot.b + 0.5); ctx.stroke();

    // Series. When there are more points than pixels, draw each pixel column's min/max.
    ctx.save();
    ctx.beginPath(); ctx.rect(plot.l, plot.t - 2, pw, ph + 4); ctx.clip();
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    for (const { k, s, i0, i1 } of spans) {
      ctx.strokeStyle = colors[k];
      ctx.beginPath();
      if (i1 - i0 <= pw * 2) {
        for (let i = i0; i < i1; i++) {
          const x = xOf(s.t[i]), y = yOf(s.v[i]);
          if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      } else {
        let col = null, first = 0, last = 0, mn = 0, mx = 0, started = false;
        const flush = () => {
          if (col === null) return;
          if (!started) { ctx.moveTo(col, first); started = true; } else ctx.lineTo(col, first);
          ctx.lineTo(col, mn); ctx.lineTo(col, mx); ctx.lineTo(col, last);
        };
        for (let i = i0; i < i1; i++) {
          const x = Math.round(xOf(s.t[i])), y = yOf(s.v[i]);
          if (x !== col) { flush(); col = x; first = mn = mx = y; }
          else { if (y < mn) mn = y; if (y > mx) mx = y; }
          last = y;
        }
        flush();
      }
      ctx.stroke();
    }
    ctx.restore();

    // Picked span (waiting for Zoom / Statistics / Regression), and the span of a hovered result.
    const shade = (s0, s1, fill, stroke) => {
      const x0 = Math.max(plot.l, xOf(s0)), x1 = Math.min(plot.r, xOf(s1));
      if (x1 <= x0) return;
      ctx.fillStyle = fill;
      ctx.fillRect(x0, plot.t, x1 - x0, ph);
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, plot.t + 0.5, Math.max(0, x1 - x0 - 1), ph - 1); }
    };
    if (opts.pick) shade(opts.pick.start, opts.pick.end, 'rgba(79, 139, 255, 0.18)', 'rgba(79, 139, 255, 0.8)');

    // Regression lines (dashed) and, for a hovered Statistics result, its means (dotted).
    if (opts.analyses && opts.analyses.length) {
      ctx.save();
      ctx.beginPath(); ctx.rect(plot.l, plot.t, pw, ph); ctx.clip();
      for (const a of opts.analyses) {
        const hi = a.id === opts.highlight;
        if (hi) shade(a.start, a.end, 'rgba(79, 139, 255, 0.10)', null);
        if (a.kind !== 'reg' && !hi) continue;
        for (const r of a.rows) {
          const c = colors[r.key];
          if (!c) continue; // not graphed right now
          ctx.strokeStyle = c;
          if (a.kind === 'reg') {
            if (!r.ok) continue;
            ctx.lineWidth = hi ? 3 : 2;
            ctx.setLineDash([7, 4]);
            ctx.beginPath();
            ctx.moveTo(xOf(a.start), yOf(r.m * a.start + r.b));
            ctx.lineTo(xOf(a.end), yOf(r.m * a.end + r.b));
            ctx.stroke();
          } else if (r.n) {
            ctx.lineWidth = 1.5;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(xOf(a.start), yOf(r.mean));
            ctx.lineTo(xOf(a.end), yOf(r.mean));
            ctx.stroke();
          }
        }
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Zoom selection being dragged out.
    if (opts.selection) {
      const x0 = Math.max(plot.l, Math.min(opts.selection.x0, opts.selection.x1));
      const x1 = Math.min(plot.r, Math.max(opts.selection.x0, opts.selection.x1));
      ctx.fillStyle = 'rgba(79, 139, 255, 0.18)';
      ctx.fillRect(x0, plot.t, x1 - x0, ph);
      ctx.strokeStyle = 'rgba(79, 139, 255, 0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, plot.t + 0.5, x1 - x0 - 1, ph - 1);
    }

    // Hover readout.
    if (opts.hoverX != null && opts.hoverX >= plot.l && opts.hoverX <= plot.r) {
      const t = range.start + ((opts.hoverX - plot.l) / pw) * (range.end - range.start);
      ctx.strokeStyle = th.axis;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(opts.hoverX + 0.5, plot.t); ctx.lineTo(opts.hoverX + 0.5, plot.b); ctx.stroke();
      ctx.setLineDash([]);

      const lines = [{ text: `t = ${t.toFixed(3)} s`, color: null }];
      for (const { k, s } of spans) {
        let i = lowerBound(s.t, t);
        if (i > 0 && (i >= s.t.length || t - s.t[i - 1] < s.t[i] - t)) i--;
        if (i < s.t.length) {
          lines.push({ text: `${k}: ${fmtValue(s.v[i])}`, color: colors[k] });
          ctx.fillStyle = colors[k];
          ctx.beginPath(); ctx.arc(xOf(s.t[i]), yOf(s.v[i]), 3.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const bw = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 30;
      const bh = lines.length * 18 + 10;
      let bx = opts.hoverX + 12;
      if (bx + bw > plot.r) bx = opts.hoverX - 12 - bw;
      const by = plot.t + 6;
      ctx.fillStyle = th.bg;
      ctx.strokeStyle = th.border;
      ctx.beginPath(); ctx.rect(bx, by, bw, bh); ctx.fill(); ctx.stroke();
      lines.forEach((l, i) => {
        const y = by + 14 + i * 18;
        if (l.color) { ctx.fillStyle = l.color; ctx.fillRect(bx + 8, y - 4, 10, 8); }
        ctx.fillStyle = th.text;
        ctx.fillText(l.text, bx + (l.color ? 24 : 8), y);
      });
    }
    return { plot, range };
  }

  let drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(draw);
  }

  function draw() {
    drawQueued = false;
    const canvas = $('chart');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width)), h = Math.max(1, Math.floor(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const run = current();
    const keys = visibleKeys(run);
    $('chart-empty').hidden = keys.length > 0;
    chartGeom = renderChart(ctx, w, h, run, keys, timeRange(run, keys), themeColors(),
      { hoverX: drag ? null : hoverX, selection: drag, pick, analyses, highlight: hoverAnalysis }) || null;
    renderLegend(keys);
    positionPickMenu();
  }

  function renderLegend(keys) {
    const el = $('legend');
    const colors = resolveColors(current(), keys);
    const sig = keys.map((k) => k + colors[k]).join('|');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.replaceChildren(...keys.map((k) => {
      const span = document.createElement('span');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = colors[k];
      span.append(sw, document.createTextNode(k));
      return span;
    }));
  }

  const chart = $('chart');
  chart.addEventListener('mousemove', (e) => { hoverX = e.offsetX; requestDraw(); });
  chart.addEventListener('mouseleave', () => { hoverX = null; requestDraw(); });

  // Drag across the graph to zoom into that time span; double-click (or Reset zoom) to go back.
  function setZoom(z) {
    zoom = z;
    $('zoom-reset').hidden = !zoom;
    renderWindowButtons();
    requestDraw();
  }
  function canvasX(e) {
    return e.clientX - chart.getBoundingClientRect().left;
  }
  chart.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !chartGeom) return;
    const x = canvasX(e);
    const { plot } = chartGeom;
    if (x < plot.l || x > plot.r) return;
    e.preventDefault(); // no text selection while dragging
    setPick(null);
    drag = { x0: x, x1: x };
    requestDraw();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    drag.x1 = canvasX(e);
    requestDraw();
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (chartGeom && Math.abs(d.x1 - d.x0) >= 5) {
      const { plot, range } = chartGeom;
      const toT = (x) => range.start + ((Math.min(plot.r, Math.max(plot.l, x)) - plot.l) / (plot.r - plot.l)) * (range.end - range.start);
      const start = toT(Math.min(d.x0, d.x1));
      const end = toT(Math.max(d.x0, d.x1));
      // Trim to where there is data, so results and fitted lines don't cover empty graph.
      const run = current();
      let first = Infinity, last = -Infinity;
      for (const k of visibleKeys(run)) {
        const t = run.series[k].t;
        first = Math.min(first, t[0]);
        last = Math.max(last, t[t.length - 1]);
      }
      const s0 = Math.max(start, first), s1 = Math.min(end, last);
      if (s1 - s0 >= 0.001) { setPick({ start: s0, end: s1 }); return; }
    }
    requestDraw();
  });
  chart.addEventListener('dblclick', () => { setPick(null); setZoom(null); });

  // ---- span menu: Zoom / Statistics / Regression -------------------------------------------------
  function setPick(p) {
    pick = p;
    $('pick-menu').hidden = !pick;
    if (pick) $('pick-label').textContent = `Δt ${fmtStat(pick.end - pick.start)} s`;
    requestDraw();
  }

  function positionPickMenu() {
    const menu = $('pick-menu');
    if (!pick) return;
    if (!chartGeom) { setPick(null); return; }
    const { plot, range } = chartGeom;
    const xOf = (t) => plot.l + ((t - range.start) / (range.end - range.start)) * (plot.r - plot.l);
    const x0 = Math.max(plot.l, xOf(pick.start)), x1 = Math.min(plot.r, xOf(pick.end));
    if (x1 <= x0) { setPick(null); return; } // scrolled off the graph
    const wrap = chart.parentElement.clientWidth;
    const mw = menu.offsetWidth;
    const left = Math.max(4, Math.min(wrap - mw - 4, (x0 + x1) / 2 - mw / 2));
    menu.style.transform = `translate(${Math.round(left)}px, ${Math.round(plot.t + 8)}px)`;
  }

  $('pick-menu').addEventListener('mousedown', (e) => e.stopPropagation());
  $('pick-menu').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !pick) return;
    const p = pick;
    setPick(null);
    if (b.dataset.act === 'zoom') setZoom({ start: p.start, end: p.end });
    else if (b.dataset.act === 'stats' || b.dataset.act === 'reg') addAnalysis(b.dataset.act, p.start, p.end);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pick) setPick(null); });

  // ---- statistics and regression -----------------------------------------------------------------
  function fmtStat(v) {
    if (!Number.isFinite(v)) return '–';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e6 || a < 1e-4) return v.toExponential(3);
    return String(Number(v.toPrecision(5)));
  }

  /** Samples of series s with start <= t <= end, as [i0, i1). */
  function spanIndexes(s, start, end) {
    const i0 = lowerBound(s.t, start);
    let i1 = lowerBound(s.t, end);
    while (i1 < s.t.length && s.t[i1] <= end) i1++;
    return [i0, i1];
  }

  function statsOf(s, i0, i1) {
    const n = i1 - i0;
    if (n <= 0) return { n: 0 };
    let min = Infinity, max = -Infinity, sum = 0;
    for (let i = i0; i < i1; i++) { const v = s.v[i]; if (v < min) min = v; if (v > max) max = v; sum += v; }
    const mean = sum / n;
    let ss = 0;
    for (let i = i0; i < i1; i++) { const d = s.v[i] - mean; ss += d * d; }
    // Sample standard deviation (n − 1).
    return { n, min, max, range: max - min, mean, sd: n > 1 ? Math.sqrt(ss / (n - 1)) : NaN };
  }

  /** Least-squares line y = m·x + b, x = time in seconds (the graph's time axis). */
  function regressionOf(s, i0, i1) {
    const n = i1 - i0;
    if (n < 2) return { n, ok: false };
    let mx = 0, my = 0;
    for (let i = i0; i < i1; i++) { mx += s.t[i]; my += s.v[i]; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = i0; i < i1; i++) {
      const dx = s.t[i] - mx, dy = s.v[i] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    if (sxx === 0) return { n, ok: false };
    const m = sxy / sxx;
    return { n, ok: true, m, b: my - m * mx, r2: syy === 0 ? NaN : (sxy * sxy) / (sxx * syy) };
  }

  let analysisSeq = 0;
  function addAnalysis(kind, start, end) {
    const run = current();
    const keys = visibleKeys(run);
    if (!keys.length) return;
    const colors = resolveColors(run, keys);
    const rows = keys.map((key) => {
      const s = run.series[key];
      const [i0, i1] = spanIndexes(s, start, end);
      return Object.assign({ key, color: colors[key] }, kind === 'stats' ? statsOf(s, i0, i1) : regressionOf(s, i0, i1));
    });
    analyses.push({ id: ++analysisSeq, kind, start, end, rows });
    renderAnalyses();
  }

  function clearAnalyses() {
    analyses = [];
    hoverAnalysis = null;
    renderAnalyses();
  }

  /** The text of one result, as label/value lines. Used for both the sidebar and the PNG. */
  function analysisRows(a, r) {
    if (a.kind === 'stats') {
      if (!r.n) return [['', 'no samples']];
      return [['Range', fmtStat(r.range)], ['', `${fmtStat(r.min)} … ${fmtStat(r.max)}`], ['Mean', fmtStat(r.mean)], ['Std dev', fmtStat(r.sd)]];
    }
    if (!r.ok) return [['', 'not enough samples']];
    return [['m', `${fmtStat(r.m)} /s`], ['b', fmtStat(r.b)], ['R²', r2Text(r.r2)]];
  }
  function r2Text(v) {
    return Number.isFinite(v) ? v.toFixed(4) : '–';
  }
  function analysisTitle(a) {
    return a.kind === 'stats' ? 'Statistics' : 'Regression';
  }
  function analysisSpan(a) {
    return `${fmtStat(a.start)} – ${fmtStat(a.end)} s`;
  }

  function renderAnalyses() {
    $('analysis').hidden = analyses.length === 0;
    const list = $('analysis-list');
    list.replaceChildren(...analyses.slice().reverse().map((a) => {
      const card = document.createElement('div');
      card.className = 'an-card';
      const head = document.createElement('div');
      head.className = 'an-head';
      const kind = document.createElement('span'); kind.className = 'an-kind'; kind.textContent = analysisTitle(a);
      const span = document.createElement('span'); span.className = 'an-span'; span.textContent = analysisSpan(a);
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'an-close'; close.textContent = '×'; close.title = 'Remove';
      close.addEventListener('click', () => {
        analyses = analyses.filter((x) => x !== a);
        if (hoverAnalysis === a.id) hoverAnalysis = null;
        renderAnalyses();
      });
      head.append(kind, span, close);
      card.append(head);
      const dt = document.createElement('div'); dt.className = 'an-dt'; dt.textContent = `Δt = ${fmtStat(a.end - a.start)} s`;
      card.append(dt);
      if (a.kind === 'reg') {
        const eq = document.createElement('div'); eq.className = 'an-eq'; eq.textContent = 'y = m·x + b   (x = time, s)';
        card.append(eq);
      }
      for (const r of a.rows) {
        const v = document.createElement('div'); v.className = 'an-var';
        const k = document.createElement('div'); k.className = 'an-key'; k.title = r.key;
        const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = r.color;
        k.append(sw, document.createTextNode(r.key));
        const dl = document.createElement('dl'); dl.className = 'an-vals';
        for (const [label, value] of analysisRows(a, r)) {
          const dtEl = document.createElement('dt'); dtEl.textContent = label;
          const dd = document.createElement('dd'); dd.textContent = value;
          dl.append(dtEl, dd);
        }
        v.append(k, dl);
        if (r.n) {
          const note = document.createElement('div'); note.className = 'an-note'; note.textContent = `${r.n} samples`;
          v.append(note);
        }
        card.append(v);
      }
      card.addEventListener('mouseenter', () => { hoverAnalysis = a.id; requestDraw(); });
      card.addEventListener('mouseleave', () => { if (hoverAnalysis === a.id) { hoverAnalysis = null; requestDraw(); } });
      return card;
    }));
    saveAnalyses();
    requestDraw();
  }
  $('analysis-clear').addEventListener('click', clearAnalyses);

  // Results for the live run survive a page refresh; results on a saved run don't.
  function saveAnalyses() {
    if (!viewing) store.set('objdash.analyses', { run: live.run, list: analyses });
  }
  function restoreAnalyses() {
    const saved = store.get('objdash.analyses', null);
    analyses = saved && saved.run === live.run && Array.isArray(saved.list) ? saved.list : [];
    analysisSeq = analyses.reduce((m, a) => Math.max(m, a.id || 0), analysisSeq);
    hoverAnalysis = null;
  }
  restoreAnalyses();

  /** Draws the results as a column of text at (x, y), width w. For the PNG. */
  function renderAnalysisPanel(ctx, x, y, w, h, th) {
    const font = (wt, size) => `${wt} ${size}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const mono = '13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.strokeStyle = th.border;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 12.5, y); ctx.lineTo(x - 12.5, y + h); ctx.stroke();
    let cy = y + 16;
    const bottom = y + h - 8;
    const line = (fn) => { if (cy > bottom) return false; fn(); return true; };
    // Newest first, like the sidebar.
    const list = analyses.slice().reverse();
    for (let ai = 0; ai < list.length; ai++) {
      const a = list[ai];
      if (cy + 40 > bottom) {
        ctx.fillStyle = th.muted; ctx.font = font(400, 12); ctx.textAlign = 'left';
        ctx.fillText(`… ${list.length - ai} more not shown`, x, cy);
        break;
      }
      ctx.fillStyle = th.text; ctx.font = font(600, 15); ctx.textAlign = 'left';
      ctx.fillText(analysisTitle(a), x, cy);
      ctx.fillStyle = th.muted; ctx.font = font(400, 12); ctx.textAlign = 'right';
      ctx.fillText(analysisSpan(a), x + w, cy);
      cy += 20;
      ctx.textAlign = 'left'; ctx.fillStyle = th.text; ctx.font = mono;
      ctx.fillText(`Δt = ${fmtStat(a.end - a.start)} s`, x, cy);
      cy += 18;
      if (a.kind === 'reg') {
        ctx.fillStyle = th.muted; ctx.font = font(400, 12);
        ctx.fillText('y = m·x + b   (x = time, s)', x, cy);
        cy += 18;
      }
      for (const r of a.rows) {
        if (!line(() => {
          ctx.fillStyle = r.color; ctx.fillRect(x, cy - 9, 10, 10);
          ctx.fillStyle = th.text; ctx.font = font(600, 13); ctx.textAlign = 'left';
          let name = r.key;
          while (name.length > 3 && ctx.measureText(name).width > w - 16) name = name.slice(0, -2);
          ctx.fillText(name === r.key ? name : name + '…', x + 16, cy);
        })) break;
        cy += 18;
        for (const [label, value] of analysisRows(a, r)) {
          if (!line(() => {
            ctx.fillStyle = th.muted; ctx.font = font(400, 13); ctx.textAlign = 'left';
            ctx.fillText(label, x + 16, cy);
            ctx.fillStyle = th.text; ctx.font = mono; ctx.textAlign = 'right';
            ctx.fillText(value, x + w, cy);
          })) break;
          cy += 17;
        }
        cy += 4;
      }
      cy += 14;
    }
    ctx.textAlign = 'left';
  }
  new ResizeObserver(requestDraw).observe(chart.parentElement);
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', requestDraw);

  // ---- toolbar ----------------------------------------------------------------------------------
  function renderWindowButtons() {
    for (const b of $('window').querySelectorAll('button')) b.classList.toggle('active', !zoom && Number(b.dataset.w) === windowSec);
  }
  $('window').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    windowSec = Number(b.dataset.w);
    if (!viewing) store.set('objdash.window', windowSec);
    setZoom(null);
  });
  $('zoom-reset').addEventListener('click', () => setZoom(null));

  $('pause').addEventListener('click', () => {
    if (pausedEnd == null) {
      const run = current();
      const r = timeRange(run, visibleKeys(run));
      pausedEnd = r ? r.end : null;
    } else {
      pausedEnd = null;
    }
    $('pause').textContent = pausedEnd == null ? 'Pause' : 'Resume';
    $('pause').classList.toggle('active', pausedEnd != null);
    requestDraw();
  });

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  // ---- naming helpers ---------------------------------------------------------------------------
  const pad2 = (n) => String(n).padStart(2, '0');
  function datePrefix(d = new Date()) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${d.getFullYear()}`;
  }
  function safeName(s) {
    const cleaned = String(s || '').replace(/[^A-Za-z0-9 _.\-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').replace(/\.\.+/g, '.').slice(0, 64);
    return cleaned || 'Unsorted';
  }
  const validName = (s) => NAME_RE.test(s) && !s.includes('..');

  async function getJson(url) {
    const r = await fetch(url, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  }

  // ---- save -------------------------------------------------------------------------------------
  let saveRoot = '/sdcard/FIRST/objdash';
  let nameEdited = false;
  let suggestTimer = null;

  function updateSavePath() {
    $('save-path').textContent = `${saveRoot}/${$('save-folder').value}/${$('save-name').value}.json`;
  }

  async function suggestName() {
    const folder = $('save-folder').value.trim();
    if (nameEdited || !validName(folder)) return;
    try {
      const d = await getJson(`${API}/nextname?folder=${encodeURIComponent(folder)}&prefix=${encodeURIComponent(datePrefix())}`);
      if (!nameEdited) { $('save-name').value = d.name; updateSavePath(); }
    } catch (e) { /* keep whatever is there */ }
  }

  async function openSave() {
    const run = current();
    if (!Object.keys(run.series).length) { toast('Nothing to save yet: no numeric telemetry in this run.'); return; }
    $('save-error').hidden = true;
    $('save-folder').value = viewing ? viewing.folder : safeName(run.opMode);
    $('save-name').value = viewing ? viewing.name : `${datePrefix()}-001`;
    nameEdited = !!viewing;
    updateSavePath();
    $('save-dialog').showModal();
    try {
      const d = await getJson(`${API}/runs`);
      saveRoot = d.root || saveRoot;
      $('folder-list').replaceChildren(...d.folders.map((f) => { const o = document.createElement('option'); o.value = f.name; return o; }));
      updateSavePath();
    } catch (e) { /* folder suggestions are optional */ }
    suggestName();
  }

  async function doSave(folder, name, overwrite) {
    const run = current();
    const body = JSON.stringify(Object.assign({}, run, { savedAt: new Date().toISOString(), folder, name }));
    const url = `${API}/save?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}${overwrite ? '&overwrite=1' : ''}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409 && !overwrite) {
      if (confirm(`"${name}" already exists in ${folder}. Replace it?`)) return doSave(folder, name, true);
      return null;
    }
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d.path;
  }

  $('save').addEventListener('click', openSave);
  $('save-folder').addEventListener('input', () => {
    updateSavePath();
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(suggestName, 250);
  });
  $('save-name').addEventListener('input', () => { nameEdited = true; updateSavePath(); });

  $('save-form').addEventListener('submit', async (e) => {
    if (!e.submitter || e.submitter.value !== 'save') return; // Cancel closes normally
    e.preventDefault();
    const folder = $('save-folder').value.trim();
    const name = $('save-name').value.trim();
    const err = $('save-error');
    if (!validName(folder) || !validName(name)) {
      err.textContent = 'Use letters, numbers, spaces, "_", "-" or "." (start with a letter or number, 64 max).';
      err.hidden = false;
      return;
    }
    $('save-confirm').disabled = true;
    try {
      const path = await doSave(folder, name, false);
      if (path) {
        $('save-dialog').close();
        toast(`Saved to ${path}`);
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      $('save-confirm').disabled = false;
    }
  });

  // ---- open saved run ---------------------------------------------------------------------------
  async function openList() {
    const list = $('open-list');
    const err = $('open-error');
    err.hidden = true;
    list.textContent = 'Loading…';
    $('open-dialog').showModal();
    try {
      const d = await getJson(`${API}/runs`);
      const nodes = [];
      for (const f of d.folders) {
        if (!f.runs.length) continue;
        const h = document.createElement('div');
        h.className = 'open-folder';
        h.textContent = f.name;
        nodes.push(h);
        for (const r of f.runs) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'open-run';
          const when = new Date(r.modified).toLocaleString();
          b.innerHTML = '<span></span><small></small>';
          b.children[0].textContent = r.name;
          b.children[1].textContent = `${when} · ${Math.max(1, Math.round(r.size / 1024))} KB`;
          b.addEventListener('click', () => loadRun(f.name, r.name));
          nodes.push(b);
        }
      }
      if (nodes.length) list.replaceChildren(...nodes);
      else list.textContent = 'No saved runs yet.';
    } catch (e) {
      list.textContent = '';
      err.textContent = `Couldn't list saved runs: ${e.message}`;
      err.hidden = false;
    }
  }

  async function loadRun(folder, name) {
    try {
      const data = await getJson(`${API}/run?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`);
      if (data.format !== 'objdash-run' || !data.series) throw new Error('Not an OBJ Dashboard run file');
      viewing = { folder, name, data };
      pausedEnd = null;
      setZoom(null);
      $('pause').textContent = 'Pause';
      $('pause').classList.remove('active');
      windowSec = 0;
      renderWindowButtons();
      $('viewing-name').textContent = `${folder} / ${name}`;
      $('viewing').hidden = false;
      $('open-dialog').close();
      setPick(null);
      analyses = []; hoverAnalysis = null; renderAnalyses();
      rows.forEach((r) => r.tr.remove());
      rows.clear();
      renderTable();
      requestDraw();
    } catch (e) {
      $('open-error').textContent = `Couldn't open ${name}: ${e.message}`;
      $('open-error').hidden = false;
    }
  }

  $('open').addEventListener('click', openList);
  $('back-live').addEventListener('click', () => {
    viewing = null;
    setZoom(null);
    setPick(null);
    restoreAnalyses(); // the live run's results, kept while a saved run was open
    renderAnalyses();
    windowSec = store.get('objdash.window', 30);
    renderWindowButtons();
    $('viewing').hidden = true;
    rows.forEach((r) => r.tr.remove());
    rows.clear();
    renderTable();
    requestDraw();
    refreshScan(true);
  });

  // ---- PNG export -------------------------------------------------------------------------------
  function exportPng() {
    const run = current();
    const keys = visibleKeys(run);
    if (!keys.length) { toast('Pick at least one value to graph first.'); return; }
    const W = 1600, H = 900, scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    const started = new Date(run.startedAt);
    const title = viewing ? `${run.opMode || viewing.folder} · ${viewing.name}` : (run.opMode || 'OBJ Dashboard');
    const subtitle = `Run started ${started.toLocaleString()}`;
    // Statistics / regression results go in a column on the right.
    const panelW = analyses.length ? 340 : 0;
    ctx.fillStyle = LIGHT.bg;
    ctx.fillRect(0, 0, W, H);
    renderChart(ctx, W - panelW, H, run, keys, timeRange(run, keys), LIGHT, { title, subtitle, legend: true, analyses });
    if (panelW) renderAnalysisPanel(ctx, W - panelW + 12, 80, panelW - 32, H - 100, LIGHT);

    // <OpMode>-<MM-DD-YYYY>-<NNN>, numbered per OpMode per day. The browser can't see the Downloads
    // folder, so the count is remembered in this browser.
    const prefix = `${safeName(run.opMode || (viewing && viewing.folder))}-${datePrefix()}`;
    const counterKey = `objdash.png.${prefix}`;
    const serial = (Number(store.get(counterKey, 0)) || 0) + 1;
    store.set(counterKey, serial);
    const base = `${prefix}-${String(serial).padStart(3, '0')}`;
    canvas.toBlob((blob) => {
      if (!blob) { toast("Couldn't create the PNG."); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${base}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, 'image/png');
  }
  $('png').addEventListener('click', exportPng);

  // ---- @ObjConfig variables ------------------------------------------------------------------------
  const cfgRows = new Map(); // "classId|path" -> { input, reset, msg, field, classId, last }
  let cfgSig = '';
  const cfgOpen = store.get('objdash.cfgOpen', {});

  async function loadConfig(rescan) {
    try {
      const d = await getJson(`${API}/config${rescan === true ? '?rescan=1' : ''}`);
      $('cfg-error').textContent = d.error || '';
      $('cfg-error').hidden = !d.error;
      renderConfig(d.classes || []);
      renderScan(d.scan, (d.classes || []).length === 0);
    } catch (e) { /* robot unreachable; the connection pill already says so */ }
  }

  // Scan diagnostics, shown when no @ObjConfig classes were found.
  function renderScan(scan, show) {
    const el = $('cfg-scan');
    el.hidden = !show || !scan;
    if (el.hidden) return;
    const sig = JSON.stringify(scan);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    $('cfg-scan-summary').textContent = scan.summary;
    $('cfg-scan-notes').replaceChildren(...scan.notes.map((n) => {
      const li = document.createElement('li');
      li.textContent = n;
      return li;
    }));
  }

  function lastSegment(path) {
    const i = path.lastIndexOf('.');
    return i < 0 ? path : path.slice(i + 1);
  }

  function cfgHeading(text) {
    const h = document.createElement('div');
    h.className = 'cfg-heading';
    h.textContent = text;
    return h;
  }

  function buildConfig(classes, usedCount) {
    cfgRows.clear();
    const nodes = classes.map((c) => {
      const det = document.createElement('details');
      det.className = 'cfg-class';
      det.open = cfgOpen[c.id] !== false;
      det.addEventListener('toggle', () => { cfgOpen[c.id] = det.open; store.set('objdash.cfgOpen', cfgOpen); });
      const sum = document.createElement('summary');
      sum.textContent = c.name;
      sum.title = c.id;
      det.appendChild(sum);

      for (const f of c.fields) {
        const indent = `${f.depth * 14}px`;
        if (f.type === 'group') {
          const g = document.createElement('div');
          g.className = 'cfg-group';
          g.style.paddingLeft = indent;
          g.textContent = lastSegment(f.path);
          det.appendChild(g);
          continue;
        }
        const row = document.createElement('div');
        row.className = 'cfg-row';
        const name = document.createElement('span');
        name.className = 'cfg-name';
        name.style.paddingLeft = indent;
        name.textContent = lastSegment(f.path);
        name.title = f.path;

        let input;
        const entry = { field: f, classId: c.id, last: f.value };
        if (f.type === 'boolean') {
          input = document.createElement('input');
          input.type = 'checkbox';
          input.addEventListener('change', () => applyConfig(entry, input.checked ? 'true' : 'false'));
        } else if (f.type === 'enum') {
          input = document.createElement('select');
          input.className = 'input';
          for (const o of f.options) {
            const opt = document.createElement('option');
            opt.value = opt.textContent = o;
            input.appendChild(opt);
          }
          input.addEventListener('change', () => applyConfig(entry, input.value));
        } else {
          input = document.createElement('input');
          input.type = 'text';
          input.className = 'input';
          input.spellcheck = false;
          input.autocomplete = 'off';
          if (f.type !== 'string') input.inputMode = f.type === 'integer' ? 'numeric' : 'decimal';
          input.addEventListener('input', () => {
            input.classList.toggle('dirty', input.value !== entry.last);
            input.classList.remove('bad', 'ok');
          });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); applyConfig(entry, input.value); }
            if (e.key === 'Escape') { input.value = entry.last; input.classList.remove('dirty', 'bad'); entry.msg.hidden = true; }
          });
          input.addEventListener('blur', () => { if (input.value !== entry.last) applyConfig(entry, input.value); });
        }
        input.disabled = f.readOnly;
        input.setAttribute('aria-label', f.path);
        if (f.readOnly) input.title = 'final: read-only';

        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'cfg-reset';
        reset.textContent = '↺';
        reset.addEventListener('click', () => applyConfig(entry, entry.field.default));

        const msg = document.createElement('div');
        msg.className = 'cfg-msg';
        msg.hidden = true;

        Object.assign(entry, { input, reset, msg });
        cfgRows.set(`${c.id}|${f.path}`, entry);
        row.append(name, input, reset, msg);
        det.appendChild(row);
      }
      return det;
    });
    if (usedCount > 0) {
      nodes.splice(0, 0, cfgHeading(`Used by ${scan.opMode}`));
      if (usedCount < classes.length) nodes.splice(usedCount + 1, 0, cfgHeading('Other classes'));
    }
    $('cfg-body').replaceChildren(...nodes);
  }

  let lastConfigClasses = null;
  function rerenderConfig() {
    if (lastConfigClasses) renderConfig(lastConfigClasses);
  }

  function showConfigValue(entry) {
    const { input, field } = entry;
    if (field.type === 'boolean') input.checked = entry.last === 'true';
    else input.value = entry.last;
    entry.reset.hidden = field.readOnly || entry.last === field.default;
    entry.reset.title = `Reset to ${field.default}`;
  }

  function renderConfig(classes) {
    lastConfigClasses = classes;
    const all = classes.length;
    // Show only the classes the selected OpMode uses (found by the source scan). If no OpMode is
    // selected or its source couldn't be read, show everything rather than hide config.
    const filtered = !!scan.ok && scan.opMode === targetOpMode();
    if (filtered) {
      const used = scan.classes || [];
      // Nested @ObjConfig classes (Outer$Inner) belong to the Outer.java file the scan found.
      classes = classes.filter((c) => used.some((u) => c.id === u || c.id.startsWith(u + '$')));
    }
    const sig = JSON.stringify([filtered && scan.opMode, classes.map((c) => [c.id, c.name, c.fields.map((f) => [f.path, f.type, f.readOnly, f.options])])]);
    if (sig !== cfgSig) {
      cfgSig = sig;
      buildConfig(classes, filtered ? classes.length : 0);
    }
    for (const c of classes) {
      for (const f of c.fields) {
        const entry = cfgRows.get(`${c.id}|${f.path}`);
        if (!entry) continue;
        entry.field = f;
        // Don't overwrite a box the user is typing in.
        const editing = entry.busy || (entry.field.type !== 'boolean' && entry.field.type !== 'enum'
          && (document.activeElement === entry.input || entry.input.classList.contains('dirty')));
        if (!editing) {
          entry.last = f.value;
          showConfigValue(entry);
        }
      }
    }
    $('cfg-empty').hidden = classes.length > 0;
    $('cfg-empty-all').hidden = !(filtered && all === 0);
    $('cfg-empty-op').hidden = !(filtered && all > 0);
    $('cfg-empty-op-name').textContent = scan.opMode || '';
    if (!filtered) $('cfg-empty-all').hidden = false;
  }

  async function applyConfig(entry, value) {
    const { input, msg, field } = entry;
    entry.busy = true;
    try {
      const url = `${API}/config/set?class=${encodeURIComponent(entry.classId)}&path=${encodeURIComponent(field.path)}&value=${encodeURIComponent(value)}`;
      const r = await fetch(url, { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      entry.last = d.value;
      input.classList.remove('dirty', 'bad');
      msg.hidden = true;
      showConfigValue(entry);
      input.classList.add('ok');
      setTimeout(() => input.classList.remove('ok'), 700);
    } catch (e) {
      input.classList.add('bad');
      msg.textContent = e.message;
      msg.hidden = false;
      if (field.type === 'boolean' || field.type === 'enum') showConfigValue(entry); // undo the visual change
    } finally {
      entry.busy = false;
    }
  }

  $('cfg-refresh').addEventListener('click', () => { refreshScan(true); loadConfig(true); });

  // Refresh about 10 times a second (also picks up values changed by code). The next request is
  // scheduled only after the previous one finishes, so slow Wi-Fi can't pile requests up.
  async function configLoop() {
    await loadConfig();
    setTimeout(configLoop, 100);
  }

  // ---- start ------------------------------------------------------------------------------------
  renderWindowButtons();
  renderAnalyses();
  renderTable();
  updateStatus();
  requestDraw();
  loadOpModes();
  configLoop();
  poll();
})();
