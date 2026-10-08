// Workload: people × weeks. Each cell compares the hours open tasks ask for
// with the hours the person actually has that week (capacity), and shows
// what projects were promised (allocation) underneath. The page has scope
// filters; workloadGrid() is the same grid for the project Workload tab and
// the person page.

import { h, mount, icon, todayStr, addDays, mondayOf, parseDate } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t, can, local, entityById, deptName } from '../lib/state.js';
import { spinner, emptyState, avatar, fmtDate, statusPill, dueBadge } from '../lib/ui.js';

const WEEK_OPTIONS = [4, 8, 12, 26];
const intlLocale = () => (state.locale === 'el' ? 'el-GR' : 'en-GB');

// 32.5 → "32.5", 40 → "40" — locale-aware, one decimal at most.
export function num(x) {
  return new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 }).format(Math.round((x || 0) * 10) / 10);
}
const hrs = (x) => `${num(x)}${t('common.hours_short')}`;

function isoWeek(s) {
  const d = parseDate(s);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const jan4 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
}

// Load colour: nothing booked → wl-0, ≤ 70 % → wl-1, ≤ 100 % → wl-2, more → wl-3.
export function loadClass(w) {
  if (!w.tasks) return 'wl-0';
  if (w.load_pct <= 70) return 'wl-1';
  if (w.load_pct <= 100) return 'wl-2';
  return 'wl-3';
}
const isAway = (w) => w.capacity === 0 && w.leave > 0;

// ---- the page ---------------------------------------------------------------

export default async function workloadPage(root, params, query) {
  const saved = local.get('workload.filters', {});
  const f = {
    scope: saved.scope || (can('people', 1) ? 'all' : 'me'),
    department_id: saved.department_id || state.me.department_id || state.departments[0]?.id || '',
    entity_id: saved.entity_id || state.me.entity_id || state.entities[0]?.id || '',
    project_id: saved.project_id || '',
    weeks: WEEK_OPTIONS.includes(saved.weeks) ? saved.weeks : 8,
    from: query.from && /^\d{4}-\d{2}-\d{2}$/.test(query.from) ? mondayOf(query.from) : mondayOf(todayStr()),
  };
  if (state.me.is_external && f.scope !== 'project') f.scope = 'me';

  let projects = [];
  try { projects = (await api.list('/projects', { member: 'me', limit: 200, sort: 'name' })).data; } catch { /* the project scope just stays empty */ }
  if (f.scope === 'project' && !projects.some(p => String(p.id) === String(f.project_id))) f.project_id = projects[0]?.id || '';

  const bar = h('div', { class: 'filterbar' });
  const grid = h('div');
  mount(root, h('div', { class: 'page wide' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.workload')), h('span', { class: 'sub' }, t('wl.subtitle'))),
    bar, explainer(), grid));

  const scopes = [
    ['me', t('wl.scope_me')],
    !state.me.is_external && ['department', t('wl.scope_department')],
    !state.me.is_external && ['entity', t('wl.scope_entity')],
    ['project', t('wl.scope_project')],
    !state.me.is_external && ['all', t('wl.scope_all')],
  ].filter(Boolean);

  const save = () => {
    local.set('workload.filters', { scope: f.scope, department_id: f.department_id, entity_id: f.entity_id, project_id: f.project_id, weeks: f.weeks });
    renderBar();
    load();
  };

  function renderBar() {
    const sel = (id, label, value, options, onchange) => h('select', { class: 'input sm', id, 'aria-label': label, onchange: (e) => onchange(e.target.value) },
      options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
    mount(bar,
      sel('wl-scope', t('wl.scope'), f.scope, scopes, (v) => { f.scope = v; if (v === 'project' && !f.project_id) f.project_id = projects[0]?.id || ''; save(); }),
      f.scope === 'department' ? sel('wl-dept', t('common.department'), f.department_id, state.departments.map(d => [d.id, deptName(d) + (d.entity_id ? ` · ${entityById(d.entity_id)?.code || ''}` : '')]), (v) => { f.department_id = v; save(); }) : null,
      f.scope === 'entity' ? h('div', { class: 'seg', role: 'group', 'aria-label': t('common.entity') }, state.entities.map(e => h('button', { class: 'btn sm', title: e.name, 'aria-pressed': String(String(f.entity_id) === String(e.id)), onclick: () => { f.entity_id = e.id; save(); } }, e.code))) : null,
      f.scope === 'project' ? (projects.length
        ? sel('wl-project', t('task.project'), f.project_id, projects.map(p => [p.id, p.code ? `${p.code} — ${p.name}` : p.name]), (v) => { f.project_id = v; save(); })
        : h('span', { class: 'muted small' }, t('wl.no_projects'))) : null,
      h('span', { class: 'sep' }),
      weekNav(f, save),
      h('span', { class: 'sep' }),
      weeksSeg(f, save));
  }

  function paramsFor() {
    const p = { from: f.from, weeks: f.weeks };
    if (f.scope === 'department') p.department_id = f.department_id;
    else if (f.scope === 'entity') p.entity_id = f.entity_id;
    else if (f.scope === 'project') p.project_id = f.project_id;
    else if (f.scope === 'all') p.scope = 'all';
    return p;
  }

  let closePop = () => {};
  async function load() {
    closePop();
    if (f.scope === 'project' && !f.project_id) { mount(grid, h('div', { class: 'card' }, emptyState(t('wl.no_projects'), 'folder'))); return; }
    mount(grid, spinner());
    try {
      const data = await api.get('/workload', paramsFor());
      closePop = renderGrid(grid, data, { projectId: f.scope === 'project' ? Number(f.project_id) : null });
    } catch (e) { mount(grid, h('div', { class: 'banner danger' }, e.message || t('common.error'))); }
  }

  renderBar();
  load();
  const onHash = () => closePop();
  window.addEventListener('hashchange', onHash);
  return () => { closePop(); window.removeEventListener('hashchange', onHash); };
}

function weekNav(f, onChange) {
  const end = addDays(f.from, f.weeks * 7 - 1);
  const thisWeek = mondayOf(todayStr());
  return h('div', { class: 'row gap-4' },
    h('button', { class: 'btn sm icon-only', 'aria-label': t('wl.prev_week'), title: t('wl.prev_week'), onclick: () => { f.from = addDays(f.from, -7); onChange(); } }, icon('chevronLeft', 14)),
    h('button', { class: 'btn sm', 'aria-pressed': String(f.from === thisWeek), onclick: () => { f.from = thisWeek; onChange(); } }, t('wl.this_week')),
    h('button', { class: 'btn sm icon-only', 'aria-label': t('wl.next_week'), title: t('wl.next_week'), onclick: () => { f.from = addDays(f.from, 7); onChange(); } }, icon('chevronRight', 14)),
    h('label', { class: 'sr-only', for: 'wl-from' }, t('wl.start_week')),
    h('input', { class: 'input sm', type: 'date', id: 'wl-from', value: f.from, title: t('wl.start_week'), onchange: (e) => { if (e.target.value) { f.from = mondayOf(e.target.value); onChange(); } } }),
    h('span', { class: 'muted xs nowrap hide-mobile' }, `${fmtDate(f.from)} – ${fmtDate(end, { year: true })}`));
}

function weeksSeg(f, onChange) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': t('wl.weeks') },
    WEEK_OPTIONS.map(n => h('button', { class: 'btn sm', 'aria-pressed': String(f.weeks === n), title: t('wl.n_weeks', { n }), onclick: () => { f.weeks = n; onChange(); } }, t('wl.n_weeks_short', { n }))));
}

function explainer({ project = false } = {}) {
  const sw = (cls, label) => h('span', { class: 'wl-key' }, h('span', { class: ['wl-swatch', cls], 'aria-hidden': 'true' }), label);
  return h('div', { class: 'wl-explain mb-16' },
    h('div', { class: 'row wrap gap-12 small', role: 'list', 'aria-label': t('wl.legend') },
      h('span', { class: 'muted xs', role: 'listitem' }, t('wl.legend'), ':'),
      [sw('wl-0', t('wl.legend_none')), sw('wl-1', t('wl.legend_ok')), sw('wl-2', t('wl.legend_full')), sw('wl-3', t('wl.legend_over')), sw('wl-leave', t('wl.legend_leave'))]
        .map(x => { x.setAttribute('role', 'listitem'); return x; })),
    h('details', { class: 'wl-how mt-8', open: window.innerWidth > 600 },
      h('summary', { class: 'small' }, t('wl.how')),
      h('p', { class: 'muted small mt-8' }, t('wl.explain')),
      project ? h('p', { class: 'muted small' }, t('wl.explain_project')) : null));
}

// ---- the reusable grid ----------------------------------------------------

// workloadGrid(el, { project_id, project }) — for the project Workload tab;
// also { user_ids, weeks, controls: false, explain: false } for the person page.
export async function workloadGrid(el, { project_id, project, user_ids, weeks = 8, from, controls = true, explain = true } = {}) {
  const f = { from: from ? mondayOf(from) : mondayOf(todayStr()), weeks };
  const bar = h('div', { class: 'filterbar' });
  const grid = h('div');
  mount(el, controls ? bar : null, explain ? explainer({ project: !!project_id }) : null, grid);
  let closePop = () => {};
  const renderBar = () => mount(bar, weekNav(f, reload), h('span', { class: 'sep' }), weeksSeg(f, reload));
  async function load() {
    closePop();
    mount(grid, spinner());
    try {
      const params = { from: f.from, weeks: f.weeks };
      if (project_id) params.project_id = project_id;
      else if (user_ids) params.user_ids = user_ids;
      const data = await api.get('/workload', params);
      closePop = renderGrid(grid, data, { projectId: project_id || null, compact: !controls });
    } catch (e) { mount(grid, h('div', { class: 'banner danger' }, e.message || t('common.error'))); }
  }
  function reload() { renderBar(); load(); }
  if (controls) renderBar();
  await load();
  const onHash = () => closePop();
  window.addEventListener('hashchange', onHash);
  return () => { closePop(); window.removeEventListener('hashchange', onHash); };
}

// Renders the table into `el`; returns a function that closes an open popover.
function renderGrid(el, data, { projectId = null, compact = false } = {}) {
  if (!data.people.length) {
    mount(el, h('div', { class: 'card' }, emptyState(t('wl.no_people'), 'people')));
    return () => {};
  }
  const thisWeek = mondayOf(todayStr());
  let pop = null;
  const closePop = () => { if (pop) { pop.close(); pop = null; } };

  const head = h('tr', null,
    h('th', { scope: 'col' }, t('wl.person')),
    data.weeks.map(w => h('th', { scope: 'col', class: ['wl-week', w === thisWeek && 'wl-now'], title: `${fmtDate(w, { year: true })} – ${fmtDate(addDays(w, 6), { year: true })}` },
      h('span', { class: 'xs muted' }, t('wl.week_n', { n: isoWeek(w) })), h('br'), fmtDate(w))));

  const rows = data.people.map(p => h('tr', null,
    h('th', { scope: 'row', class: 'wl-person' },
      h('div', { class: 'row' }, avatar(p.name, p.id),
        h('div', { class: 'col gap-4', style: { minWidth: 0, gap: '1px' } },
          h('a', { href: `#/people/${p.id}`, class: 'ellipsis wl-name' }, p.name),
          h('span', { class: 'muted xs ellipsis' }, [entityById(p.entity_id)?.code, t('wl.per_week', { h: num(p.weekly_hours) })].filter(Boolean).join(' · ')),
          p.overdue_hours ? h('span', { class: 'xs danger-text nowrap', title: t('wl.overdue_hint') }, icon('alert', 11), ' ', t('wl.overdue_h', { h: num(p.overdue_hours), n: p.overdue_tasks })) : null,
          p.unscheduled_hours ? h('span', { class: 'xs warn-text nowrap', title: t('wl.unscheduled_hint') }, icon('clock', 11), ' ', t('wl.unscheduled_h', { h: num(p.unscheduled_hours) })) : null))),
    p.weeks.map(w => {
      const away = isAway(w);
      const label = t('wl.cell_label', { name: p.name, week: fmtDate(w.start), tasks: num(w.tasks), capacity: num(w.capacity), alloc: num(w.allocated), pct: w.capacity ? w.load_pct : '—' }) + (away ? ' — ' + t('wl.legend_leave') : '');
      const btn = h('button', { type: 'button', class: ['wl-cell', loadClass(w), away && 'wl-leave', w.start === thisWeek && 'wl-now'], 'aria-label': label, 'aria-haspopup': 'dialog',
        onclick: (e) => { closePop(); pop = cellPopover(e.currentTarget, p, w, data, projectId); } },
        h('span', { class: 'v' }, `${num(w.tasks)} / ${hrs(w.capacity)}`),
        h('span', { class: 'a' }, away ? t('wl.off') : t('wl.alloc_short', { h: num(w.allocated) })));
      return h('td', null, btn);
    })));

  // Arrow keys move between cells, like a spreadsheet.
  const table = h('table', { class: ['wl', compact && 'wl-compact'], onkeydown: (e) => {
    if (!e.target.classList.contains('wl-cell')) return;
    const td = e.target.parentElement, tr = td.parentElement;
    const ci = [...tr.children].indexOf(td);
    let target = null;
    if (e.key === 'ArrowRight') target = td.nextElementSibling;
    else if (e.key === 'ArrowLeft') target = ci > 1 ? td.previousElementSibling : null;
    else if (e.key === 'ArrowDown') target = tr.nextElementSibling?.children[ci];
    else if (e.key === 'ArrowUp') target = tr.previousElementSibling?.children[ci];
    else return;
    const b = target?.querySelector('.wl-cell');
    if (b) { b.focus(); e.preventDefault(); }
  } },
    h('caption', { class: 'sr-only' }, t('wl.caption')),
    h('thead', null, head), h('tbody', null, rows));
  mount(el, h('div', { class: 'table-wrap wl-wrap' }, table));
  return closePop;
}

// ---- the cell popover ---------------------------------------------------

function projectLabel(key, data) {
  if (key === 'other') return { name: t('wl.other_projects'), hint: t('wl.other_projects_hint'), color: 'var(--text-3)' };
  if (key === 'personal') return { name: t('wl.personal_tasks'), hint: t('wl.personal_hint'), color: 'var(--border-strong)' };
  const p = data.projects[key];
  return p ? { name: p.code ? `${p.code} — ${p.name}` : p.name, color: p.color || 'var(--accent)', href: `#/projects/${key}` } : { name: `#${key}`, color: 'var(--text-3)' };
}

function cellPopover(anchor, person, w, data, projectId) {
  const prev = anchor;
  const end = addDays(w.start, 6);
  const entries = Object.entries(w.by_project).sort((a, b) => b[1] - a[1]);
  const tasksBox = h('div', { class: 'col gap-4' }, h('span', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') }));
  const titleId = 'wlp-' + Math.random().toString(36).slice(2, 8);
  const stat = (k, v, cls) => h('div', { class: 'stat' }, h('span', { class: ['v', cls] }, v), h('span', { class: 'k' }, k));

  const el = h('div', { class: 'wl-pop', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'row mb-8' },
      h('div', { class: 'grow' }, h('h3', { id: titleId, class: 'ellipsis' }, person.name),
        h('div', { class: 'muted xs' }, `${t('wl.week_n', { n: isoWeek(w.start) })} · ${fmtDate(w.start)} – ${fmtDate(end, { year: true })}`)),
      h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('common.close'), onclick: () => close() }, icon('x', 14))),
    h('div', { class: 'wl-pop-stats' },
      stat(t('wl.task_load'), hrs(w.tasks), loadClass(w) === 'wl-3' ? 'danger-text' : ''),
      stat(t('wl.capacity'), hrs(w.capacity)),
      stat(t('wl.allocated'), hrs(w.allocated)),
      stat(t('wl.load'), w.capacity ? `${w.load_pct}%` : '—', loadClass(w) === 'wl-3' ? 'danger-text' : '')),
    w.leave ? h('p', { class: 'xs muted mt-8' }, icon('calendar', 11), ' ', t('wl.leave_note', { h: num(w.leave) })) : null,
    h('div', { class: 'section-title' }, t('wl.by_project')),
    entries.length ? h('ul', { class: 'wl-breakdown' }, entries.map(([k, v]) => {
      const l = projectLabel(k, data);
      return h('li', { class: ['row', projectId && String(projectId) === k && 'wl-this'] },
        h('span', { class: 'wl-dot', style: { background: l.color }, 'aria-hidden': 'true' }),
        h('span', { class: 'grow ellipsis', title: l.hint || l.name }, l.href ? h('a', { href: l.href }, l.name) : l.name, l.hint ? h('span', { class: 'muted xs' }, ' — ', l.hint) : null),
        h('span', { class: 'nowrap small', style: { fontVariantNumeric: 'tabular-nums' } }, hrs(v)));
    })) : h('p', { class: 'muted small' }, t('wl.nothing_booked')),
    h('div', { class: 'section-title' }, t('wl.tasks_this_week')),
    tasksBox,
    h('div', { class: 'row wrap mt-8' },
      person.id === state.me.id ? h('a', { class: 'btn sm', href: '#/my-tasks' }, icon('tasks', 13), t('nav.my_tasks')) : null,
      h('a', { class: 'btn sm', href: `#/people/${person.id}` }, icon('user', 13), t('wl.open_profile'))));

  document.body.appendChild(el);
  // Position under the cell; on a phone it becomes a bottom sheet (CSS).
  const r = anchor.getBoundingClientRect();
  if (window.innerWidth > 600) {
    const pw = el.offsetWidth, ph = el.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = top + 'px';
  }
  el.focus();

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const outside = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close(false); };
  el.addEventListener('keydown', onKey);
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  let closed = false;
  function close(restore = true) {
    if (closed) return;
    closed = true;
    el.remove();
    document.removeEventListener('mousedown', outside, true);
    if (restore && document.contains(prev)) prev.focus();
  }

  // The tasks behind the number: open tasks of this person touching the week.
  api.list('/tasks', { assignee: String(person.id), state: 'open', range_from: w.start, range_to: end, limit: 50, sort: 'due' })
    .then((r) => {
      if (closed) return;
      if (!r.data.length) { mount(tasksBox, h('p', { class: 'muted small' }, t('wl.no_tasks_week'))); return; }
      mount(tasksBox, h('ul', { class: 'wl-breakdown' }, r.data.map(tk => h('li', { class: 'row' },
        statusPill(tk.status),
        h('a', { class: 'grow ellipsis', href: `#/tasks/${tk.id}`, title: tk.title }, tk.title),
        tk.estimate_hours ? h('span', { class: 'muted xs nowrap' }, hrs(tk.estimate_hours)) : null,
        dueBadge(tk)))),
        r.meta?.total > r.data.length ? h('p', { class: 'muted xs' }, t('common.n_more', { n: r.meta.total - r.data.length })) : null);
    })
    .catch((e) => { if (!closed) mount(tasksBox, h('p', { class: 'muted small' }, e.status === 403 ? t('wl.tasks_hidden') : (e.message || t('common.error')))); });

  return { close: () => close(false) };
}

