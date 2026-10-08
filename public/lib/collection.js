// A task collection: filter bar + saved views + view switcher over one task
// query, rendered as list, board, timeline or calendar. Projects and My Tasks
// both use it, so every task set behaves the same way everywhere.
//
// Renderer contract (views/task-*.js): export default function (el, c) where
// c = { tasks, project, filters, group, reload, update(task, patch), open(id),
//       createTask(fields), sections, statuses }. May return a cleanup fn.

import { h, mount, icon, debounce, todayStr, addDays, mondayOf } from './dom.js';
import { api } from './api.js';
import { state, t, on, local, statusLabel } from './state.js';
import { toast, showError, openMenu, formDialog, confirmDialog, spinner, avatar } from './ui.js';

const RENDERERS = {
  list: () => import('../views/task-list.js'),
  board: () => import('../views/task-board.js'),
  timeline: () => import('../views/task-timeline.js'),
  calendar: () => import('../views/task-calendar.js'),
};
const VIEW_ICONS = { list: 'list', board: 'board', timeline: 'timeline', calendar: 'calendar' };

export function taskCollection(root, {
  scope,                 // saved-view scope: 'project:12' | 'my_tasks' | 'all_tasks'
  base = {},             // fixed query params (project_id, assignee=me …)
  project = null,        // full project object when scoped to one project
  views = ['list', 'board', 'timeline', 'calendar'],
  defaultView = 'list',
  defaultFilters = { state: 'recent' },
  members = [],
  showProject = false,   // show the project column (cross-project lists)
} = {}) {
  const key = 'coll.' + scope;
  const saved = local.get(key, {});
  const c = {
    view: views.includes(saved.view) ? saved.view : defaultView,
    filters: { ...defaultFilters, ...(saved.filters || {}) },
    group: saved.group || (project ? 'section' : 'due'),
    tasks: [], project, members, showProject, base, scope,
    savedViews: [], activeViewId: null,
  };
  const bar = h('div', { class: 'filterbar', role: 'toolbar', 'aria-label': t('common.filters') });
  const body = h('div');
  mount(root, bar, body);
  let cleanupRenderer = null;
  let seq = 0;

  const persist = () => local.set(key, { view: c.view, filters: c.filters, group: c.group });

  async function load() {
    const my = ++seq;
    const params = { ...base, ...queryFor(c), limit: 500 };
    try {
      const r = await api.list('/tasks', params);
      if (my !== seq) return;
      c.tasks = r.data;
      c.total = r.meta.total;
      await renderBody();
    } catch (e) { if (my === seq) mount(body, h('div', { class: 'banner danger' }, e.message)); }
  }

  async function renderBody() {
    if (cleanupRenderer) { try { cleanupRenderer(); } catch {} cleanupRenderer = null; }
    const mod = await RENDERERS[c.view]();
    const el = h('div');
    mount(body, el);
    cleanupRenderer = mod.default(el, api_(c)) || null;
    if (c.total > c.tasks.length) body.prepend(h('div', { class: 'banner warn mb-8' }, t('coll.truncated', { n: c.tasks.length, total: c.total })));
  }

  const api_ = (c) => ({
    ...c,
    reload: load,
    open: (id) => { location.hash = `#/tasks/${id}`; },
    update: async (task, patch) => {
      try {
        const u = await api.patch(`/tasks/${task.id}`, patch, task.updated_at);
        const i = c.tasks.findIndex(x => x.id === task.id);
        if (i >= 0) c.tasks[i] = { ...c.tasks[i], ...u };
        return u;
      } catch (e) { showError(e); load(); throw e; }
    },
    createTask: async (fields) => {
      const body = { ...fields };
      if (project) body.project_id = project.id;
      if (!project && base.assignee === 'me' && body.assignee_id === undefined) body.assignee_id = state.me.id;
      const n = await api.post('/tasks', body); // callers show the error
      await load();
      return n;
    },
  });

  function renderBar() {
    const f = c.filters;
    const q = h('input', { class: 'input', type: 'search', placeholder: t('coll.filter_placeholder'), value: f.q || '', 'aria-label': t('coll.filter_placeholder'), style: { width: '180px' },
      oninput: debounce((e) => { f.q = e.target.value || undefined; persist(); load(); }, 300) });
    const chip = (label, active, onclick) => h('button', { class: 'btn sm', 'aria-pressed': String(!!active), onclick }, label);

    const stateBtn = h('button', { class: 'btn sm', onclick: (e) => openMenu(e.currentTarget, [
      ['open', t('coll.state_open')], ['recent', t('coll.state_recent')], ['done', t('coll.state_done')], ['all', t('coll.state_all')],
    ].map(([v, l]) => ({ label: l, value: v, checked: (f.state || 'all') === v })), { onSelect: (v) => { f.state = v; persist(); renderBar(); load(); } }) },
      icon('filter', 13), t('coll.state_' + (f.state || 'all')));

    const assigneeBtn = !base.assignee ? h('button', { class: 'btn sm', 'aria-pressed': String(!!f.assignee), onclick: (e) => openMenu(e.currentTarget, [
      { label: t('coll.anyone'), value: undefined, checked: !f.assignee },
      { label: t('common.me'), value: 'me', checked: f.assignee === 'me' },
      { label: t('task.unassigned'), value: 'none', checked: f.assignee === 'none' },
      ...(members.length ? [{ sep: true }] : []),
      ...members.map(m => ({ label: m.name, value: String(m.user_id), checked: f.assignee === String(m.user_id), icon: avatar(m.name, m.user_id) })),
    ], { search: members.length > 6, onSelect: (v) => { f.assignee = v; persist(); renderBar(); load(); } }) },
      icon('user', 13), f.assignee === 'me' ? t('common.me') : f.assignee === 'none' ? t('task.unassigned') : f.assignee ? (members.find(m => String(m.user_id) === f.assignee)?.name || '…') : t('task.assignee')) : null;

    const dueBtn = h('button', { class: 'btn sm', 'aria-pressed': String(!!f.due), onclick: (e) => openMenu(e.currentTarget, [
      ['', t('coll.due_any')], ['overdue', t('coll.due_overdue')], ['week', t('coll.due_week')], ['month', t('coll.due_month')], ['none', t('coll.due_none')],
    ].map(([v, l]) => ({ label: l, value: v, checked: (f.due || '') === v })), { onSelect: (v) => { f.due = v || undefined; persist(); renderBar(); load(); } }) },
      icon('calendar', 13), f.due ? t('coll.due_' + f.due) : t('task.due_date'));

    const prioBtn = h('button', { class: 'btn sm', 'aria-pressed': String(!!f.priority), onclick: (e) => openMenu(e.currentTarget, [
      { label: t('coll.any_priority'), value: undefined, checked: !f.priority },
      { label: t('coll.high_and_urgent'), value: 'high,urgent', checked: f.priority === 'high,urgent' },
      ...['urgent', 'high', 'medium', 'low', 'none'].map(v => ({ label: t('task.priority_' + v), value: v, checked: f.priority === v })),
    ], { onSelect: (v) => { f.priority = v; persist(); renderBar(); load(); } }) }, icon('flag', 13), f.priority ? (f.priority === 'high,urgent' ? t('coll.high_and_urgent') : t('task.priority_' + f.priority)) : t('task.priority'));

    const labelBtn = project && project.labels.length ? h('button', { class: 'btn sm', 'aria-pressed': String(!!f.label_id), onclick: (e) => openMenu(e.currentTarget, [
      { label: t('coll.any_label'), value: undefined, checked: !f.label_id },
      ...project.labels.map(l => ({ label: l.name, value: String(l.id), checked: f.label_id === String(l.id), icon: h('span', { class: 'chip label', style: { background: l.color, width: '10px', padding: 0 } }) })),
    ], { onSelect: (v) => { f.label_id = v; persist(); renderBar(); load(); } }) }, icon('star', 13), f.label_id ? project.labels.find(l => String(l.id) === f.label_id)?.name : t('task.labels')) : null;

    const groupBtn = c.view === 'list' || c.view === 'board' ? h('button', { class: 'btn sm', onclick: (e) => openMenu(e.currentTarget, [
      ...(project ? [['section', t('coll.group_section')]] : []), ['status', t('coll.group_status')], ['due', t('coll.group_due')], ['assignee', t('coll.group_assignee')], ['priority', t('coll.group_priority')],
      ...(!project ? [['project', t('coll.group_project')]] : []), ['none', t('coll.group_none')],
    ].map(([v, l]) => ({ label: l, value: v, checked: c.group === v })), { onSelect: (v) => { c.group = v; persist(); renderBar(); renderBody(); } }) }, icon('board', 13), t('coll.group_by'), ': ', t('coll.group_' + c.group)) : null;

    const active = ['q', 'assignee', 'due', 'priority', 'label_id'].some(k => f[k]);
    const clear = active ? h('button', { class: 'btn ghost sm', onclick: () => { c.filters = { ...defaultFilters }; c.activeViewId = null; persist(); renderBar(); load(); } }, icon('x', 13), t('common.clear')) : null;

    const viewsBtn = h('button', { class: 'btn sm', onclick: (e) => savedViewsMenu(e.currentTarget) }, icon('eye', 13),
      c.activeViewId ? (c.savedViews.find(v => v.id === c.activeViewId)?.name || t('common.views')) : t('common.views'));

    const switcher = views.length > 1 ? h('div', { class: 'seg', role: 'tablist', 'aria-label': t('coll.layout') }, views.map(v => h('button', { class: 'btn sm', role: 'tab', 'aria-selected': String(c.view === v), 'aria-pressed': String(c.view === v), title: t('coll.view_' + v),
      onclick: () => { c.view = v; persist(); renderBar(); load(); } }, icon(VIEW_ICONS[v], 14), h('span', { class: 'hide-mobile' }, t('coll.view_' + v))))) : null;

    mount(bar, switcher, h('span', { class: 'sep' }), q, stateBtn, assigneeBtn, dueBtn, prioBtn, labelBtn, groupBtn, clear, h('span', { class: 'right' }), viewsBtn);
  }

  async function loadSavedViews() {
    try { c.savedViews = (await api.list('/views', { scope })).data; } catch { c.savedViews = []; }
  }

  function savedViewsMenu(anchor) {
    openMenu(anchor, [
      ...(c.savedViews.length ? [{ head: t('coll.saved_views') }] : []),
      ...c.savedViews.map(v => ({ label: v.name, value: v, checked: c.activeViewId === v.id, hint: v.mine ? (v.shared ? t('coll.shared') : '') : v.owner_name, onSelect: () => applyView(v) })),
      { sep: true },
      { label: t('coll.save_view'), icon: 'plus', onSelect: saveView },
      ...(c.activeViewId && c.savedViews.find(v => v.id === c.activeViewId)?.mine ? [
        { label: t('coll.update_view'), icon: 'check', onSelect: updateView },
        { label: t('coll.delete_view'), icon: 'trash', danger: true, onSelect: deleteView },
      ] : []),
    ]);
  }

  function applyView(v) {
    c.activeViewId = v.id;
    c.filters = { ...defaultFilters, ...(v.config.filters || {}) };
    if (views.includes(v.view_type)) c.view = v.view_type;
    if (v.config.group) c.group = v.config.group;
    persist(); renderBar(); load();
  }

  function saveView() {
    formDialog({
      title: t('coll.save_view'), submitLabel: t('common.save'),
      fields: [{ name: 'name', label: t('common.name'), required: true }, { name: 'shared', label: t('coll.share_view'), type: 'checkbox', hint: t('coll.share_hint') }, { name: 'is_default', label: t('coll.default_view'), type: 'checkbox' }],
      onSubmit: async (v) => {
        const n = await api.post('/views', { scope, name: v.name, view_type: c.view, shared: v.shared, is_default: v.is_default, config: { filters: c.filters, group: c.group } });
        await loadSavedViews(); c.activeViewId = n.id; renderBar(); toast(t('common.saved'));
      },
    });
  }

  async function updateView() {
    const v = c.savedViews.find(x => x.id === c.activeViewId);
    try { await api.patch(`/views/${v.id}`, { view_type: c.view, config: { filters: c.filters, group: c.group } }, v.updated_at); await loadSavedViews(); toast(t('common.saved')); } catch (e) { showError(e); }
  }

  async function deleteView() {
    const v = c.savedViews.find(x => x.id === c.activeViewId);
    if (!await confirmDialog(t('common.confirm_delete', { name: v.name }))) return;
    try { await api.del(`/views/${v.id}`); c.activeViewId = null; await loadSavedViews(); renderBar(); } catch (e) { showError(e); }
  }

  const offChanged = on('task:changed', debounce(() => load(), 250));
  const offDeleted = on('task:deleted', () => load());

  (async () => {
    renderBar();
    mount(body, spinner());
    await loadSavedViews();
    const def = c.savedViews.find(v => v.is_default && v.mine);
    if (def && !saved.view) applyView(def); else { renderBar(); load(); }
  })();

  return () => { offChanged(); offDeleted(); if (cleanupRenderer) cleanupRenderer(); };
}

// Collection filters → /api/tasks query parameters.
export function queryFor(c) {
  const f = c.filters, p = {};
  if (f.q) p.q = f.q;
  if (f.state && f.state !== 'all') p.state = f.state;
  if (f.assignee) p.assignee = f.assignee;
  if (f.priority) p.priority = f.priority;
  if (f.label_id) p.label_id = f.label_id;
  if (f.section_id) p.section_id = f.section_id;
  const today = todayStr();
  if (f.due === 'overdue') p.overdue = 1;
  else if (f.due === 'week') { p.due_from = today; p.due_to = addDays(mondayOf(today), 6); }
  else if (f.due === 'month') { p.due_from = today; p.due_to = addDays(today, 30); }
  else if (f.due === 'none') p.no_due = 1;
  // Lists and boards show top-level tasks (subtasks expand under them);
  // the timeline and calendar show everything that has dates.
  if ((c.view === 'list' || c.view === 'board') && c.project) p.parent = 'none';
  return p;
}

// Grouping shared by list and board.
export function groupTasks(tasks, group, { project } = {}) {
  const today = todayStr();
  const weekEnd = addDays(mondayOf(today), 6);
  const groups = new Map();
  const add = (k, label, task, order = 0, extra = {}) => {
    if (!groups.has(k)) groups.set(k, { key: k, label, order, tasks: [], ...extra });
    if (task) groups.get(k).tasks.push(task);
  };
  if (group === 'section' && project) {
    add('none', t('task.no_section'), null, -1, { section_id: null });
    project.sections.forEach((s, i) => add('s' + s.id, s.name, null, i, { section_id: s.id }));
    for (const tk of tasks) add(tk.section_id ? 's' + tk.section_id : 'none', '', tk);
    const none = groups.get('none');
    if (none && !none.tasks.length && project.sections.length) groups.delete('none');
  } else if (group === 'status') {
    state.statuses.forEach((s, i) => add(s.key, statusLabel(s.key), null, i, { status: s.key, color: s.color }));
    for (const tk of tasks) add(tk.status, statusLabel(tk.status), tk);
  } else if (group === 'due') {
    const order = ['overdue', 'today', 'week', 'later', 'nodate', 'done'];
    for (const k of order) add(k, t('coll.bucket_' + k), null, order.indexOf(k));
    for (const tk of tasks) {
      const k = tk.completed_at ? 'done' : !tk.due_date ? 'nodate' : tk.due_date < today ? 'overdue' : tk.due_date === today ? 'today' : tk.due_date <= weekEnd ? 'week' : 'later';
      add(k, '', tk);
    }
    for (const [k, g] of groups) if (!g.tasks.length) groups.delete(k);
  } else if (group === 'assignee') {
    for (const tk of tasks) add('u' + (tk.assignee_id || 0), tk.assignee_name || t('task.unassigned'), tk, tk.assignee_id ? 0 : 1, { assignee_id: tk.assignee_id || null });
  } else if (group === 'priority') {
    const order = ['urgent', 'high', 'medium', 'low', 'none'];
    for (const k of order) add(k, t('task.priority_' + k), null, order.indexOf(k), { priority: k });
    for (const tk of tasks) add(tk.priority, '', tk);
    for (const [k, g] of groups) if (!g.tasks.length) groups.delete(k);
  } else if (group === 'project') {
    for (const tk of tasks) add('p' + (tk.project_id || 0), tk.project_id ? (tk.project_code || tk.project_name) : t('task.personal'), tk, tk.project_id ? 0 : 1, { project_id: tk.project_id });
  } else {
    add('all', t('coll.all_tasks'), null);
    for (const tk of tasks) add('all', '', tk);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
