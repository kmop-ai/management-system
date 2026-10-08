// List renderer for a task collection: grouped rows, inline add per group,
// subtasks expand in place, drag to reorder or move between groups.
// Keyboard: rows are focusable; Enter opens, X toggles done, ↑/↓ move focus.

import { h, mount, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, local, emit } from '../lib/state.js';
import { avatar, statusPill, prioIcon, dueBadge, labelChip, showError, emptyState, hours, toast } from '../lib/ui.js';
import { groupTasks } from '../lib/collection.js';

export default function renderList(el, c) {
  const collapsed = new Set(local.get('collapsed.' + c.scope, []));
  const expanded = new Set();
  const groups = groupTasks(c.tasks, c.group, { project: c.project });
  const canWork = !c.project || c.project.access?.work;
  const list = h('div', { class: 'tlist', role: 'list' });
  let dragTask = null;

  if (!c.tasks.length && !(c.group === 'section' && c.project?.sections.length)) {
    mount(el, h('div', { class: 'tlist' }, emptyState(t('coll.no_tasks'), 'check'), canWork ? addRow(null) : null));
    return;
  }

  list.append(h('div', { class: 'trow-head', 'aria-hidden': 'true' }, h('span'), h('span', null, t('common.title')), h('span', { class: 'c-assignee' }, t('task.assignee')), h('span', null, t('task.due_date')), h('span', { class: 'c-status' }, t('common.status')), h('span', { class: 'c-extra' }, t('task.estimate_short'))));

  for (const g of groups) {
    const isCollapsed = collapsed.has(g.key);
    const rows = h('div', { class: isCollapsed ? 'hidden' : '' });
    const head = h('div', { class: 'tgroup-head', dataset: { group: g.key },
      ondragover: (e) => { if (dragTask && canDropInto(g)) { e.preventDefault(); head.style.background = 'var(--accent-soft)'; } },
      ondragleave: () => { head.style.background = ''; },
      ondrop: (e) => { head.style.background = ''; if (dragTask) { e.preventDefault(); moveTo(dragTask, g, null); } } },
      h('button', { class: 'toggle', 'aria-expanded': String(!isCollapsed), 'aria-label': g.label, onclick: () => {
        const now = rows.classList.toggle('hidden');
        if (now) collapsed.add(g.key); else collapsed.delete(g.key);
        local.set('collapsed.' + c.scope, [...collapsed]);
        head.querySelector('.toggle').setAttribute('aria-expanded', String(!now));
      } }, icon(isCollapsed ? 'chevronRight' : 'chevronDown', 14)),
      g.color ? h('span', { class: 'status-pill', style: { '--c': g.color } }) : null,
      h('span', null, g.label), h('span', { class: 'count' }, String(g.tasks.length)));
    for (const tk of sortTasks(g.tasks, c.group)) appendTask(rows, tk, 0, g);
    if (canWork && groupAllowsAdd(g)) rows.append(addRow(g));
    list.append(h('div', { class: 'tgroup', role: 'group', 'aria-label': g.label }, head, rows));
  }
  mount(el, list);

  function groupAllowsAdd(g) { return ['section', 'status', 'priority', 'none', 'assignee'].includes(c.group) || (c.group === 'due' && ['today', 'week', 'nodate'].includes(g.key)); }
  function canDropInto(g) { return ['section', 'status', 'priority', 'assignee'].includes(c.group) && canWork; }

  function appendTask(container, tk, depth, g) {
    const row = taskRow(tk, depth, g);
    container.append(row);
    if (expanded.has(tk.id)) loadChildren(tk, row, depth, g);
  }

  async function loadChildren(tk, row, depth, g) {
    const holder = h('div', { dataset: { children: tk.id } });
    row.after(holder);
    try {
      const r = await api.list('/tasks', { parent: tk.id, limit: 200, sort: 'position' });
      for (const s of r.data) appendTask(holder, s, depth + 1, g);
    } catch (e) { showError(e); }
  }

  function taskRow(tk, depth, g) {
    const done = !!tk.completed_at;
    const row = h('div', { class: ['trow', done && 'done'], role: 'listitem', tabindex: '0', draggable: canWork && depth === 0 ? 'true' : null, dataset: { id: tk.id },
      onkeydown: (e) => onRowKey(e, tk, row),
      ondblclick: () => c.open(tk.id),
      ondragstart: (e) => { dragTask = tk; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(tk.id)); },
      ondragend: () => { dragTask = null; row.classList.remove('dragging'); },
      ondragover: (e) => { if (dragTask && dragTask.id !== tk.id && depth === 0) { e.preventDefault(); row.classList.add('drop-before'); } },
      ondragleave: () => row.classList.remove('drop-before'),
      ondrop: (e) => { row.classList.remove('drop-before'); if (dragTask && dragTask.id !== tk.id) { e.preventDefault(); e.stopPropagation(); moveTo(dragTask, g, tk); } },
    },
      h('button', { class: ['check-btn', done && 'on'], 'aria-label': done ? t('task.reopen') : t('task.mark_done'), title: done ? t('task.reopen') : t('task.mark_done'),
        onclick: (e) => { e.stopPropagation(); toggleDone(tk); } }, icon('check', 11)),
      h('div', { class: 'ttitle' },
        depth ? h('span', { class: 'indent', style: { width: `${depth * 18}px` } }) : null,
        tk.subtask_count ? h('button', { class: 'expand', 'aria-expanded': String(expanded.has(tk.id)), 'aria-label': t('task.subtasks'), onclick: (e) => {
          e.stopPropagation();
          if (expanded.has(tk.id)) { expanded.delete(tk.id); row.nextElementSibling?.dataset.children == tk.id && row.nextElementSibling.remove(); }
          else { expanded.add(tk.id); loadChildren(tk, row, depth, g); }
          e.currentTarget.replaceChildren(icon(expanded.has(tk.id) ? 'chevronDown' : 'chevronRight', 13));
          e.currentTarget.setAttribute('aria-expanded', String(expanded.has(tk.id)));
        } }, icon(expanded.has(tk.id) ? 'chevronDown' : 'chevronRight', 13)) : h('span', { class: 'expand' }),
        prioIcon(tk.priority),
        tk.is_milestone ? icon('diamond', 13) : null,
        h('a', { href: `#/tasks/${tk.id}`, tabindex: '-1' }, tk.title),
        c.showProject && tk.project_id ? h('span', { class: 'chip outline', title: tk.project_name }, tk.project_code || tk.project_name) : null,
        tk.labels.slice(0, 3).map(l => labelChip(l)),
        h('span', { class: 'meta' },
          tk.subtask_count ? h('span', { title: t('task.subtasks') }, icon('subtask'), `${tk.subtask_done}/${tk.subtask_count}`) : null,
          tk.checklist_total ? h('span', { title: t('task.checklist') }, icon('check'), `${tk.checklist_done}/${tk.checklist_total}`) : null,
          tk.comment_count ? h('span', { title: t('task.comments') }, icon('comment'), tk.comment_count) : null,
          tk.attachment_count ? h('span', { title: t('task.files') }, icon('clip'), tk.attachment_count) : null,
          tk.open_blockers ? h('span', { class: 'warn-text', title: t('task.waiting_on', { n: tk.open_blockers }) }, icon('lock')) : null,
          tk.recurrence_id ? h('span', { title: t('task.repeats') }, icon('repeat')) : null,
          tk.is_internal ? h('span', { title: t('common.internal') }, icon('eye')) : null)),
      h('div', { class: 'cell c-assignee' }, avatar(tk.assignee_name, tk.assignee_id), h('span', { class: 'ellipsis' }, tk.assignee_name || '')),
      h('div', { class: 'cell' }, dueBadge(tk, { projectStart: c.project?.start_date })),
      h('div', { class: 'cell c-status' }, statusPill(tk.status)),
      h('div', { class: 'cell c-extra muted' }, tk.estimate_hours ? hours(tk.estimate_hours) : ''));
    row.addEventListener('click', (e) => { if (!e.target.closest('button, a, input')) c.open(tk.id); });
    return row;
  }

  function onRowKey(e, tk, row) {
    if (e.target !== row) return;
    if (e.key === 'Enter') { e.preventDefault(); c.open(tk.id); }
    else if (e.key.toLowerCase() === 'x') { e.preventDefault(); toggleDone(tk); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = [...el.querySelectorAll('.trow')].filter(r => r.offsetParent !== null);
      const i = rows.indexOf(row);
      const next = rows[e.key === 'ArrowDown' ? i + 1 : i - 1];
      if (next) { next.focus(); e.preventDefault(); }
    }
  }

  async function toggleDone(tk) {
    try {
      await c.update(tk, { completed: !tk.completed_at });
      if (!tk.completed_at) toast(t('task.completed_toast', { title: tk.title }), { ms: 2500, action: async () => { try { await api.patch(`/tasks/${tk.id}`, { completed: false }); c.reload(); } catch (e) { showError(e); } } });
      c.reload();
      emit('task:list-changed');
    } catch {}
  }

  // Drop: move into group g, before task `before` (or at the end).
  async function moveTo(task, g, before) {
    const patch = {};
    if (c.group === 'section') patch.section_id = g.section_id ?? null;
    if (c.group === 'status') patch.status = g.status;
    if (c.group === 'priority') patch.priority = g.priority;
    if (c.group === 'assignee') patch.assignee_id = g.assignee_id;
    const siblings = sortTasks(g.tasks.filter(x => x.id !== task.id), c.group);
    if (before) {
      const i = siblings.findIndex(x => x.id === before.id);
      const prev = siblings[i - 1];
      patch.position = prev ? (prev.position + before.position) / 2 : before.position - 1;
    } else patch.position = siblings.length ? siblings[siblings.length - 1].position + 1 : 1;
    try { await c.update(task, patch); c.reload(); } catch {}
  }

  function addRow(g) {
    const input = h('input', { class: 'input sm bare', placeholder: t('coll.add_task'), 'aria-label': t('coll.add_task') + (g ? ` — ${g.label}` : '') });
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const fields = { title: input.value.trim() };
      if (g) {
        if (c.group === 'section') fields.section_id = g.section_id ?? null;
        if (c.group === 'status') fields.status = g.status;
        if (c.group === 'priority') fields.priority = g.priority;
        if (c.group === 'assignee' && g.assignee_id) fields.assignee_id = g.assignee_id;
        if (c.group === 'due') fields.due_date = g.key === 'today' ? new Date().toISOString().slice(0, 10) : undefined;
      }
      input.value = '';
      try {
        await c.createTask(fields);
        requestAnimationFrame(() => {
          const again = [...el.querySelectorAll('.add-row input')].find(x => x.getAttribute('aria-label') === input.getAttribute('aria-label'));
          again?.focus();
        });
      } catch (err) { showError(err); input.value = fields.title; }
    });
    return h('div', { class: 'add-row' }, icon('plus', 14, 'muted'), input);
  }
}

function sortTasks(tasks, group) {
  // Within a section the user's own order (position) wins; elsewhere, due date.
  if (group === 'section' || group === 'none') return [...tasks].sort((a, b) => a.position - b.position || a.id - b.id);
  return [...tasks].sort((a, b) => (a.completed_at ? 1 : 0) - (b.completed_at ? 1 : 0) || (a.due_date || '9999').localeCompare(b.due_date || '9999') || a.position - b.position);
}
