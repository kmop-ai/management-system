// Timeline (Gantt) renderer for a task collection.
//
// One scroll container holds a sticky name column, a sticky header and the
// chart, so names and bars always scroll together. Bars are absolutely
// positioned; grid lines and weekend shading are CSS backgrounds; all
// dependency arrows live in one SVG. Rebuilt only on zoom / collapse /
// critical-path toggles, never on scroll, so a few hundred tasks stay smooth.
//
// Keyboard: task names form a tree — ↑/↓ move, →/← expand/collapse, Enter
// opens, Alt+←/→ moves the task's dates by one day.

import { h, mount, icon, todayStr, parseDate, fmtISO, addDays, daysBetween, mondayOf, projectMonth } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t, local } from '../lib/state.js';
import { emptyState, fmtDate, avatar } from '../lib/ui.js';

const ROW = 32;
const HEAD_ROW = 20;
const ZOOMS = { day: 28, week: 9, month: 3 }; // px per day
const SVGNS = 'http://www.w3.org/2000/svg';

export default function renderTimeline(el, c) {
  const canWork = !c.project || c.project.access?.work;
  const today = todayStr();
  const scopeKey = c.scope || 'default';
  let zoom = local.get('tl.zoom', 'week');
  if (!ZOOMS[zoom]) zoom = 'week';
  let showCritical = !!local.get('tl.critical.' + scopeKey, false);
  const collapsed = new Set(local.get('tl.collapsed.' + scopeKey, []));
  let deps = [];
  let depsState = c.project ? 'loading' : 'none';
  let alive = true;
  let firstDraw = true;

  // ---- the task tree -------------------------------------------------------
  const byId = new Map(c.tasks.map(x => [x.id, x]));
  const kids = new Map();
  const roots = [];
  for (const tk of c.tasks) {
    if (tk.parent_id && byId.has(tk.parent_id)) { if (!kids.has(tk.parent_id)) kids.set(tk.parent_id, []); kids.get(tk.parent_id).push(tk); }
    else roots.push(tk);
  }
  const byPlan = (a, b) => (a.position - b.position) || (a.id - b.id);
  const byDate = (a, b) => (spanOf(a)?.s || '9999').localeCompare(spanOf(b)?.s || '9999') || byPlan(a, b);
  for (const list of kids.values()) list.sort(byDate);

  // Subtree date range, memoised: own dates or the children's.
  const treeSpan = new Map();
  function subtreeSpan(tk) {
    if (treeSpan.has(tk.id)) return treeSpan.get(tk.id);
    let sp = spanOf(tk);
    for (const k of kids.get(tk.id) || []) {
      const ks = subtreeSpan(k);
      if (ks) sp = sp ? { s: sp.s < ks.s ? sp.s : ks.s, e: sp.e > ks.e ? sp.e : ks.e } : { ...ks };
    }
    treeSpan.set(tk.id, sp);
    return sp;
  }

  // Groups of scheduled roots (by section in a project), then unscheduled.
  const groups = [];
  const scheduledRoots = roots.filter(r => subtreeSpan(r));
  const unscheduled = roots.filter(r => !subtreeSpan(r)).sort(byPlan);
  if (c.project) {
    const known = new Set(c.project.sections.map(s => s.id));
    const none = scheduledRoots.filter(r => !r.section_id || !known.has(r.section_id)).sort(byPlan);
    if (none.length) groups.push({ key: 'none', label: t('task.no_section'), tasks: none });
    for (const s of c.project.sections) {
      const list = scheduledRoots.filter(r => r.section_id === s.id).sort(byPlan);
      if (list.length) groups.push({ key: 's' + s.id, label: s.name, tasks: list });
    }
  } else if (scheduledRoots.length) {
    groups.push({ key: 'all', label: t('coll.all_tasks'), tasks: scheduledRoots.sort(byDate) });
  }
  if (unscheduled.length) groups.push({ key: 'unscheduled', label: t('tl.unscheduled'), tasks: unscheduled, unscheduled: true });

  if (!c.tasks.length) { mount(el, h('div', { class: 'tlist' }, emptyState(t('coll.no_tasks'), 'timeline'))); return; }

  // ---- date range ----------------------------------------------------------
  let min = today, max = today;
  for (const tk of c.tasks) { const sp = spanOf(tk); if (sp) { if (sp.s < min) min = sp.s; if (sp.e > max) max = sp.e; } }
  if (c.project?.start_date && c.project.start_date < min) min = c.project.start_date;
  if (c.project?.end_date && c.project.end_date > max) max = c.project.end_date;
  const rangeStart = mondayOf(firstOfMonth(min));
  const rangeEnd = addDays(firstOfMonth(addMonths(max, 2)), -1);
  const totalDays = daysBetween(rangeStart, rangeEnd) + 1;
  const offset = (d) => daysBetween(rangeStart, d);

  const intl = state.locale === 'el' ? 'el-GR' : 'en-GB';
  const fmtMonthLong = new Intl.DateTimeFormat(intl, { month: 'long', year: 'numeric' });
  const fmtMonthShort = new Intl.DateTimeFormat(intl, { month: 'short' });

  // ---- shell: toolbar + scroller ------------------------------------------
  const zoomSeg = h('div', { class: 'seg', role: 'group', 'aria-label': t('tl.zoom') },
    [['day', t('tl.zoom_day')], ['week', t('tl.zoom_week')], ['month', t('tl.zoom_month')]].map(([z, label]) =>
      h('button', { class: 'btn sm', type: 'button', 'aria-pressed': String(zoom === z), dataset: { zoom: z }, onclick: () => setZoom(z) }, label)));
  const critBtn = h('button', { class: 'btn sm', type: 'button', 'aria-pressed': String(showCritical), onclick: () => {
    showCritical = !showCritical; local.set('tl.critical.' + scopeKey, showCritical); critBtn.setAttribute('aria-pressed', String(showCritical)); draw();
  } }, icon('alert', 13), t('tl.critical'));
  const todayBtn = h('button', { class: 'btn sm', type: 'button', onclick: () => scrollToDate(today, true) }, t('common.today'));
  const toolbar = h('div', { class: 'tl-bar' }, zoomSeg, todayBtn, critBtn,
    canWork ? h('span', { class: 'muted xs hide-mobile tl-hint' }, t('tl.drag_hint')) : null);
  const scroller = h('div', { class: 'tl', tabindex: '-1' });
  mount(el, toolbar, scroller);
  updateCritButton();

  if (c.project) {
    api.get(`/projects/${c.project.id}/dependencies`).then((d) => {
      if (!alive) return;
      deps = d || []; depsState = 'ok'; updateCritButton(); draw();
    }).catch(() => { if (alive) { depsState = 'error'; updateCritButton(); } });
  }

  function updateCritButton() {
    const usable = depsState === 'ok' && deps.length > 0;
    critBtn.disabled = !usable;
    critBtn.title = depsState === 'none' || (depsState === 'ok' && !deps.length) ? t('tl.critical_none') : t('tl.critical_hint');
    critBtn.setAttribute('aria-description', critBtn.title);
  }

  function setZoom(z) {
    if (z === zoom) return;
    // keep the date in the middle of the view in the middle after zooming
    const center = dateAtX(scroller.scrollLeft + Math.max(0, scroller.clientWidth - leftWidth()) / 2);
    zoom = z; local.set('tl.zoom', z);
    zoomSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.zoom === z)));
    draw();
    scrollToDate(center);
  }

  let D = ZOOMS[zoom];
  const leftWidth = () => scroller.querySelector('.tl-names')?.offsetWidth || 0;
  const xOf = (d) => offset(d) * D;
  const dateAtX = (x) => addDays(rangeStart, Math.max(0, Math.floor(x / D)));
  function scrollToDate(d, smooth = false) {
    const visible = Math.max(0, scroller.clientWidth - leftWidth());
    scroller.scrollTo({ left: Math.max(0, xOf(d) - visible / 2), behavior: smooth ? 'smooth' : 'auto' });
  }

  // ---- drawing -------------------------------------------------------------
  let rowIndex = new Map(); // task id → row number (visible rows only)
  let crit = { set: new Set(), slack: new Map() };

  function draw() {
    D = ZOOMS[zoom];
    const keepTop = scroller.scrollTop, keepLeft = scroller.scrollLeft;
    crit = showCritical && deps.length ? criticalPath() : { set: new Set(), slack: new Map() };
    const rows = buildRows();
    rowIndex = new Map();
    rows.forEach((r, i) => { if (r.task) rowIndex.set(r.task.id, i); });
    const W = totalDays * D;
    const H = Math.max(rows.length * ROW, ROW * 3);
    const headRows = headerRows();
    const headH = headRows.length * HEAD_ROW;

    const names = h('div', { class: 'tl-names', role: 'tree', 'aria-label': t('coll.view_timeline') });
    rows.forEach((r, i) => names.append(nameRow(r, i)));
    const firstFocusable = names.querySelector('[role=treeitem]');
    if (firstFocusable) firstFocusable.tabIndex = 0;

    const chart = h('div', { class: ['tl-chart', canWork && 'can-drag'], style: { width: W + 'px', height: H + 'px', backgroundImage: chartBackground(), backgroundSize: 'auto' } });
    // month separators
    for (let m = firstOfMonth(rangeStart); m <= rangeEnd; m = addMonths(m, 1)) {
      const x = xOf(m);
      if (x > 0) chart.append(h('div', { class: 'tl-mline', style: { left: x + 'px' } }));
    }
    // section bands
    rows.forEach((r, i) => { if (r.group) chart.append(h('div', { class: 'tl-band', style: { top: i * ROW + 'px' } })); });
    // project span (start/end markers)
    if (c.project?.start_date) chart.append(h('div', { class: 'tl-pline', style: { left: xOf(c.project.start_date) + 'px' }, title: `M1 · ${fmtDate(c.project.start_date, { year: true })}` }));
    if (c.project?.end_date) chart.append(h('div', { class: 'tl-pline', style: { left: xOf(addDays(c.project.end_date, 1)) + 'px' }, title: fmtDate(c.project.end_date, { year: true }) }));
    // today
    chart.append(h('div', { class: 'g-today', style: { left: (xOf(today) + D / 2 - 1) + 'px' }, title: t('common.today') }));
    // bars
    const frag = document.createDocumentFragment();
    rows.forEach((r, i) => { if (r.task) bar(frag, r, i); });
    chart.append(frag);
    // arrows
    chart.append(arrows(W, H));

    const head = h('div', { class: 'tl-head', style: { width: W + 'px', height: headH + 'px' }, 'aria-hidden': 'true' });
    headRows.forEach((cells, ri) => {
      for (const cell of cells) head.append(h('div', { class: ['tl-hcell', cell.cls], style: { left: cell.x + 'px', width: cell.w + 'px', top: ri * HEAD_ROW + 'px' }, title: cell.title || null }, cell.w > 60 ? h('span', null, cell.label) : cell.label));
    });
    const corner = h('div', { class: 'tl-corner', style: { height: headH + 'px' } }, h('span', null, t('tl.task')));

    const grid = h('div', { class: 'tl-grid', style: { gridTemplateColumns: `var(--tl-left) ${W}px`, gridTemplateRows: `${headH}px ${H}px` } }, corner, head, names, chart);
    mount(scroller, grid);
    attachDrag(chart);
    if (firstDraw) { firstDraw = false; requestAnimationFrame(() => scrollToDate(today)); }
    else { scroller.scrollTop = keepTop; scroller.scrollLeft = keepLeft; }
  }

  function buildRows() {
    const rows = [];
    const addTree = (tk, depth, g) => {
      const children = kids.get(tk.id) || [];
      const open = children.length && !collapsed.has('t' + tk.id);
      rows.push({ task: tk, depth, hasKids: children.length > 0, open, unscheduled: g.unscheduled });
      if (open) for (const k of children) addTree(k, depth + 1, g);
    };
    const showHeads = groups.length > 1 || c.project;
    for (const g of groups) {
      const open = !collapsed.has('g' + g.key);
      if (showHeads) rows.push({ group: g, open });
      if (open || !showHeads) for (const tk of g.tasks) addTree(tk, 0, g);
    }
    return rows;
  }

  function toggle(key) {
    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
    local.set('tl.collapsed.' + scopeKey, [...collapsed]);
    draw();
    requestAnimationFrame(() => scroller.querySelector(`[data-key="${key}"]`)?.focus({ preventScroll: true }));
  }

  // ---- left pane -----------------------------------------------------------
  function nameRow(r, i) {
    if (r.group) {
      const key = 'g' + r.group.key;
      return h('div', { class: 'g-row tl-grow', role: 'treeitem', 'aria-level': '1', 'aria-expanded': String(r.open), tabindex: '-1', dataset: { key, i },
        onkeydown: (e) => onNameKey(e, r, key), onclick: () => toggle(key) },
        icon(r.open ? 'chevronDown' : 'chevronRight', 13, 'muted'),
        h('span', { class: 'ellipsis grow' }, r.group.label),
        h('span', { class: 'muted xs' }, String(r.group.tasks.length)));
    }
    const tk = r.task, key = 't' + tk.id;
    const level = (groups.length > 1 || c.project ? 2 : 1) + r.depth;
    const row = h('div', { class: ['g-row', 'tl-nrow', tk.completed_at && 'done', crit.set.has(tk.id) && 'critical'], role: 'treeitem', 'aria-level': String(level),
      'aria-expanded': r.hasKids ? String(r.open) : null, tabindex: '-1', dataset: { key, i, id: tk.id },
      onkeydown: (e) => onNameKey(e, r, key),
      onclick: (e) => { if (!e.target.closest('.tl-toggle')) c.open(tk.id); } },
      h('span', { class: 'tl-indent', style: { width: r.depth * 16 + 'px' } }),
      r.hasKids ? h('button', { class: 'tl-toggle', type: 'button', tabindex: '-1', 'aria-hidden': 'true', onclick: (e) => { e.stopPropagation(); toggle(key); } }, icon(r.open ? 'chevronDown' : 'chevronRight', 13))
        : h('span', { class: 'tl-toggle' }),
      tk.is_milestone ? icon('diamond', 12, 'muted') : null,
      h('span', { class: 'ellipsis grow tl-title' }, tk.title),
      tk.assignee_id ? h('span', { class: 'hide-mobile' }, avatar(tk.assignee_name, tk.assignee_id)) : null);
    return row;
  }

  function onNameKey(e, r, key) {
    const row = e.currentTarget;
    const all = [...scroller.querySelectorAll('.tl-names [role=treeitem]')];
    const i = all.indexOf(row);
    const focus = (n) => { if (!n) return; row.tabIndex = -1; n.tabIndex = 0; n.focus(); e.preventDefault(); };
    if (e.altKey && r.task && canWork && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const sp = spanOf(r.task);
      if (sp) shiftTask(r.task, e.key === 'ArrowRight' ? 1 : -1, key);
      return;
    }
    if (e.key === 'ArrowDown') focus(all[i + 1]);
    else if (e.key === 'ArrowUp') focus(all[i - 1]);
    else if (e.key === 'Home') focus(all[0]);
    else if (e.key === 'End') focus(all[all.length - 1]);
    else if (e.key === 'ArrowRight') {
      if ((r.group || r.hasKids) && !r.open) { e.preventDefault(); toggle(key); }
      else focus(all[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      if ((r.group || r.hasKids) && r.open) { e.preventDefault(); toggle(key); }
      else {
        const lvl = Number(row.getAttribute('aria-level'));
        for (let j = i - 1; j >= 0; j--) if (Number(all[j].getAttribute('aria-level')) < lvl) { focus(all[j]); break; }
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (r.group) toggle(key); else c.open(r.task.id);
    }
    if (document.activeElement?.dataset?.id) {
      const sp = spanOf(byId.get(Number(document.activeElement.dataset.id)));
      if (sp && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) revealDate(sp.s);
    }
  }

  // Scroll horizontally only if the date is out of view.
  function revealDate(d) {
    const x = xOf(d), lw = leftWidth();
    if (x < scroller.scrollLeft || x > scroller.scrollLeft + scroller.clientWidth - lw - 40) scroller.scrollLeft = Math.max(0, x - 40);
  }

  // ---- header --------------------------------------------------------------
  function headerRows() {
    const out = [];
    const months = [];
    for (let m = firstOfMonth(rangeStart); m <= rangeEnd; m = addMonths(m, 1)) {
      const x0 = Math.max(0, xOf(m)), x1 = Math.min(totalDays * D, xOf(addMonths(m, 1)));
      if (x1 > x0) months.push({ m, x: x0, w: x1 - x0 });
    }
    if (zoom === 'month') {
      const years = [];
      for (const mo of months) {
        const y = mo.m.slice(0, 4);
        const last = years[years.length - 1];
        if (last && last.label === y) last.w += mo.w; else years.push({ label: y, x: mo.x, w: mo.w });
      }
      out.push(years);
      out.push(months.map(mo => ({ x: mo.x, w: mo.w, label: fmtMonthShort.format(parseDate(mo.m)), title: fmtMonthLong.format(parseDate(mo.m)) })));
    } else {
      out.push(months.map(mo => ({ x: mo.x, w: mo.w, label: mo.w > 90 ? fmtMonthLong.format(parseDate(mo.m)) : fmtMonthShort.format(parseDate(mo.m)) })));
    }
    if (c.project?.start_date) {
      const endM = c.project.end_date ? projectMonth(c.project.start_date, c.project.end_date) : Infinity;
      out.push(months.map(mo => {
        const n = projectMonth(c.project.start_date, mo.m);
        return n >= 1 && n <= endM ? { x: mo.x, w: mo.w, label: 'M' + n, cls: 'pm', title: `${t('tl.project_month')} M${n} · ${fmtMonthLong.format(parseDate(mo.m))}` } : { x: mo.x, w: mo.w, label: '', cls: 'pm' };
      }));
    }
    if (zoom === 'day') {
      const cells = [];
      for (let i = 0; i < totalDays; i++) {
        const d = parseDate(addDays(rangeStart, i));
        const wd = d.getDay();
        cells.push({ x: i * D, w: D, label: String(d.getDate()), cls: [(wd === 0 || wd === 6) && 'we', i === offset(today) && 'now'].filter(Boolean).join(' ') });
      }
      out.push(cells);
    } else if (zoom === 'week') {
      const cells = [];
      for (let i = 0; i < totalDays; i += 7) {
        const ds = addDays(rangeStart, i);
        cells.push({ x: i * D, w: 7 * D, label: String(parseDate(ds).getDate()), title: fmtDate(ds, { year: true }), cls: ds === mondayOf(today) ? 'now' : '' });
      }
      out.push(cells);
    }
    return out;
  }

  function chartBackground() {
    const layers = [`repeating-linear-gradient(to bottom, transparent 0 ${ROW - 1}px, var(--border) ${ROW - 1}px ${ROW}px)`];
    if (zoom === 'day') {
      layers.push(`repeating-linear-gradient(to right, transparent 0 ${D - 1}px, var(--tl-day-line) ${D - 1}px ${D}px)`);
      layers.push(`repeating-linear-gradient(to right, transparent 0 ${5 * D}px, var(--tl-weekend) ${5 * D}px ${7 * D}px)`);
    } else if (zoom === 'week') {
      layers.push(`repeating-linear-gradient(to right, transparent 0 ${7 * D - 1}px, var(--tl-day-line) ${7 * D - 1}px ${7 * D}px)`);
    }
    return layers.join(', ');
  }

  // ---- bars ----------------------------------------------------------------
  function bar(frag, r, i) {
    const tk = r.task;
    const own = spanOf(tk);
    const y = i * ROW;
    if (!own) {
      // a parent without dates of its own: a thin bracket over its subtasks
      const sp = subtreeSpan(tk);
      if (sp) frag.append(h('div', { class: 'tl-summary', style: { left: xOf(sp.s) + 'px', width: (offset(sp.e) - offset(sp.s) + 1) * D + 'px', top: (y + 13) + 'px' }, title: `${tk.title}\n${fmtDate(sp.s, { year: true })} → ${fmtDate(sp.e, { year: true })}` }));
      return;
    }
    const left = xOf(own.s), width = Math.max((offset(own.e) - offset(own.s) + 1) * D, 4);
    const done = !!tk.completed_at;
    const critical = crit.set.has(tk.id);
    const pm = c.project?.start_date ? [projectMonth(c.project.start_date, own.s), projectMonth(c.project.start_date, own.e)] : null;
    const tip = [tk.title,
      (own.s !== own.e ? `${fmtDate(own.s, { year: true })} → ` : '') + fmtDate(own.e, { year: true }) + (pm ? ` · M${pm[0]}${pm[1] !== pm[0] ? '–M' + pm[1] : ''}` : ''),
      crit.slack.has(tk.id) ? (critical ? t('tl.on_critical') : t('tl.slack', { n: crit.slack.get(tk.id) })) : null].filter(Boolean).join('\n');
    let b, right;
    if (tk.is_milestone) {
      const cx = xOf(own.e) + D / 2;
      b = h('div', { class: ['g-bar', 'ms', done && 'done', critical && 'critical'], style: { left: (cx - 7) + 'px', top: (y + 9) + 'px' }, dataset: { id: tk.id }, title: tip });
      right = cx + 10;
    } else {
      b = h('div', { class: ['g-bar', done && 'done', critical && 'critical'], style: { left: left + 'px', width: width + 'px', top: (y + 7) + 'px' }, dataset: { id: tk.id }, title: tip },
        canWork && !done ? h('span', { class: 'tl-resize', 'aria-hidden': 'true' }) : null);
      right = left + width;
    }
    if (canWork && !done) b.classList.add('tl-draggable');
    frag.append(b, h('span', { class: ['tl-label', done && 'done'], style: { left: (right + 6) + 'px', top: y + 'px' }, dataset: { id: tk.id } }, tk.title));
  }

  // ---- dependency arrows -----------------------------------------------------
  function arrows(W, H) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'tl-arrows');
    svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('aria-hidden', 'true');
    const defs = document.createElementNS(SVGNS, 'defs');
    for (const id of ['tl-ah', 'tl-ah-crit']) {
      const m = document.createElementNS(SVGNS, 'marker');
      m.setAttribute('id', id); m.setAttribute('viewBox', '0 0 8 8'); m.setAttribute('refX', '7'); m.setAttribute('refY', '4');
      m.setAttribute('markerWidth', '7'); m.setAttribute('markerHeight', '7'); m.setAttribute('orient', 'auto');
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', 'M0,0 L8,4 L0,8 z');
      p.setAttribute('class', id === 'tl-ah' ? 'ah' : 'ah crit');
      m.append(p); defs.append(m);
    }
    svg.append(defs);
    const add = (path, isCrit) => {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('d', path);
      if (isCrit) p.setAttribute('class', 'crit');
      p.setAttribute('marker-end', `url(#${isCrit ? 'tl-ah-crit' : 'tl-ah'})`);
      svg.append(p);
    };
    for (const dep of deps) {
      const a = byId.get(dep.blocker_id), b = byId.get(dep.blocked_id);
      if (!a || !b || !rowIndex.has(a.id) || !rowIndex.has(b.id)) continue;
      const sa = spanOf(a), sb = spanOf(b);
      if (!sa || !sb) continue;
      const x1 = a.is_milestone ? xOf(sa.e) + D / 2 + 8 : xOf(sa.e) + D;
      const x2 = b.is_milestone ? xOf(sb.e) + D / 2 - 8 : xOf(sb.s);
      const y1 = rowIndex.get(a.id) * ROW + ROW / 2, y2 = rowIndex.get(b.id) * ROW + ROW / 2;
      const xa = x1 + 8, xb = x2 - 8;
      // elbow: out of the blocker's end, down/up, into the blocked task's start;
      // when the blocked task starts before the blocker ends, route between rows.
      const ym = y2 + (y2 > y1 ? -ROW / 2 : ROW / 2);
      add(xb >= xa ? `M${x1},${y1}H${xa}V${y2}H${x2}` : `M${x1},${y1}H${xa}V${ym}H${xb}V${y2}H${x2}`, crit.set.has(a.id) && crit.set.has(b.id));
    }
    return svg;
  }

  // ---- critical path ---------------------------------------------------------
  // Forward/backward pass over the dependency graph in whole days, using
  // each bar's duration. Slack is how far a task could slip before the end
  // of the whole dependency chain slips. Zero slack = critical.
  function criticalPath() {
    const node = new Map();
    const edges = deps.filter(d => byId.has(d.blocker_id) && byId.has(d.blocked_id) && spanOf(byId.get(d.blocker_id)) && spanOf(byId.get(d.blocked_id)));
    for (const e of edges) for (const id of [e.blocker_id, e.blocked_id]) {
      if (node.has(id)) continue;
      const tk = byId.get(id), sp = spanOf(tk);
      node.set(id, { start: offset(sp.s), dur: tk.is_milestone ? 0 : offset(sp.e) - offset(sp.s) + 1, preds: [], succs: [] });
    }
    for (const e of edges) { node.get(e.blocked_id).preds.push(e); node.get(e.blocker_id).succs.push(e); }
    // topological order (the server refuses cycles; guard anyway)
    const indeg = new Map([...node].map(([id, n]) => [id, n.preds.length]));
    const order = [], queue = [...node.keys()].filter(id => !indeg.get(id));
    while (queue.length) {
      const id = queue.shift(); order.push(id);
      for (const e of node.get(id).succs) { indeg.set(e.blocked_id, indeg.get(e.blocked_id) - 1); if (!indeg.get(e.blocked_id)) queue.push(e.blocked_id); }
    }
    if (order.length !== node.size) return { set: new Set(), slack: new Map() };
    let end = -Infinity;
    for (const id of order) {
      const n = node.get(id);
      // ASAP: a chain starts on its first task's own date; every later task
      // starts as soon as its blockers finish (+ lag), whatever gap the plan
      // has — so the critical chain is the longest one by bar durations.
      n.es = n.preds.length ? -Infinity : n.start;
      for (const e of n.preds) n.es = Math.max(n.es, node.get(e.blocker_id).ef + (e.lag_days || 0));
      n.ef = n.es + n.dur;
      end = Math.max(end, n.ef);
    }
    for (const id of [...order].reverse()) {
      const n = node.get(id);
      n.lf = end;
      for (const e of n.succs) n.lf = Math.min(n.lf, node.get(e.blocked_id).ls - (e.lag_days || 0));
      n.ls = n.lf - n.dur;
    }
    const set = new Set(), slack = new Map();
    for (const [id, n] of node) { const s = n.ls - n.es; slack.set(id, s); if (s <= 0) set.add(id); }
    return { set, slack };
  }

  // ---- drag to reschedule ----------------------------------------------------
  function attachDrag(chart) {
    let st = null;
    chart.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const b = e.target.closest('.g-bar');
      if (!b) return;
      const tk = byId.get(Number(b.dataset.id));
      if (!tk) return;
      const mode = e.target.closest('.tl-resize') ? 'resize' : 'move';
      st = { b, tk, mode, x0: e.clientX, left: b.offsetLeft, width: b.offsetWidth, days: 0, moved: false, draggable: b.classList.contains('tl-draggable'), label: chart.querySelector(`.tl-label[data-id="${tk.id}"]`) };
      st.labelLeft = st.label ? st.label.offsetLeft : 0;
      if (st.draggable) { b.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    chart.addEventListener('pointermove', (e) => {
      if (!st || !st.draggable) return;
      const dx = e.clientX - st.x0;
      if (!st.moved && Math.abs(dx) < 4) return;
      st.moved = true;
      st.b.classList.add('dragging');
      let days = Math.round(dx / D);
      const sp = spanOf(st.tk);
      if (st.mode === 'resize') days = Math.max(days, offset(sp.s) - offset(sp.e)); // due never before start
      st.days = days;
      if (st.mode === 'move') { st.b.style.left = (st.left + days * D) + 'px'; if (st.label) st.label.style.left = (st.labelLeft + days * D) + 'px'; }
      else { st.b.style.width = Math.max(st.width + days * D, 4) + 'px'; if (st.label) st.label.style.left = (st.labelLeft + days * D) + 'px'; }
      const n = newDates(st.tk, st.mode, days);
      showTip(chart, st.b, (n.start_date && n.start_date !== n.due_date ? fmtDate(n.start_date) + ' → ' : '') + fmtDate(n.due_date || n.start_date));
    });
    const finish = async (e, cancelled) => {
      if (!st) return;
      const s = st; st = null;
      hideTip(chart);
      if (!s.moved) { if (!cancelled) c.open(s.tk.id); return; }
      s.b.classList.remove('dragging');
      if (cancelled || !s.days) { s.b.style.left = s.left + 'px'; s.b.style.width = s.width + 'px'; if (s.label) s.label.style.left = s.labelLeft + 'px'; return; }
      await save(s.tk, newDates(s.tk, s.mode, s.days));
    };
    chart.addEventListener('pointerup', (e) => finish(e, false));
    chart.addEventListener('pointercancel', (e) => finish(e, true));
    chart.addEventListener('click', (e) => {
      const l = e.target.closest('.tl-label');
      if (l) c.open(Number(l.dataset.id));
    });
  }

  function newDates(tk, mode, days) {
    const sp = spanOf(tk);
    if (mode === 'resize') return { start_date: tk.start_date || null, due_date: addDays(sp.e, days) };
    return { start_date: tk.start_date ? addDays(tk.start_date, days) : null, due_date: tk.due_date ? addDays(tk.due_date, days) : null };
  }

  async function shiftTask(tk, days, key) {
    await save(tk, newDates(tk, 'move', days));
    requestAnimationFrame(() => document.querySelector(`.tl-names [data-key="${key}"]`)?.focus());
  }

  async function save(tk, patch) {
    try { await c.update(tk, patch); await c.reload(); } catch {}
  }

  let tipEl = null;
  function showTip(chart, b, text) {
    if (!tipEl) tipEl = h('div', { class: 'tl-tip', role: 'status' });
    if (tipEl.parentNode !== chart) chart.append(tipEl);
    tipEl.textContent = text;
    tipEl.style.left = b.offsetLeft + 'px';
    tipEl.style.top = Math.max(0, b.offsetTop - 24) + 'px';
  }
  function hideTip() { tipEl?.remove(); }

  draw();
  return () => { alive = false; };
}

// A task's drawn span: start→due, or a one-day bar when only one is set.
function spanOf(tk) {
  if (!tk) return null;
  const s = tk.start_date || tk.due_date, e = tk.due_date || tk.start_date;
  if (!s) return null;
  return s <= e ? { s, e } : { s: e, e: s };
}
const firstOfMonth = (s) => s.slice(0, 8) + '01';
function addMonths(s, n) { const d = parseDate(firstOfMonth(s)); d.setMonth(d.getMonth() + n); return fmtISO(d); }
