// Board renderer for a task collection: one column per group (section,
// status, assignee or priority), cards dragged between columns or moved with
// the keyboard through each card's "move to…" menu.
// Keyboard: cards are focusable; Enter opens, ←/→ jump between columns,
// ↑/↓ between cards, M opens the move menu.

import { h, mount, icon } from '../lib/dom.js';
import { t } from '../lib/state.js';
import { avatar, prioIcon, dueBadge, labelChip, emptyState, openMenu, showError } from '../lib/ui.js';
import { groupTasks } from '../lib/collection.js';

const BOARD_GROUPS = ['section', 'status', 'assignee', 'priority'];

export default function renderBoard(el, c) {
  const group = BOARD_GROUPS.includes(c.group) && !(c.group === 'section' && !c.project) ? c.group : 'status';
  const canWork = !c.project || c.project.access?.work;
  // A project board shows top-level tasks (subtasks live on their parent's card).
  const tasks = c.project ? c.tasks.filter(x => !x.parent_id) : c.tasks;
  const columns = groupTasks(tasks, group, { project: c.project });
  for (const col of columns) col.tasks = sortCards(col.tasks);
  const board = h('div', { class: 'board', role: 'region', 'aria-label': t('coll.view_board') });
  let drag = null;           // { task, from: column }
  let indicator = null;      // the drop line element

  if (!columns.length) {
    mount(el, h('div', { class: 'tlist' }, emptyState(t('coll.no_tasks'), 'board')));
    return;
  }

  for (const col of columns) board.append(column(col));
  mount(el, board);

  // ---- columns -------------------------------------------------------------

  function column(col) {
    const body = h('div', { class: 'bcol-body', role: 'list', 'aria-label': col.label });
    for (const tk of col.tasks) body.append(card(tk, col));
    if (!col.tasks.length) body.append(h('div', { class: 'bcol-empty muted xs' }, t('board.empty_column')));
    const el = h('section', { class: 'bcol', dataset: { col: col.key }, 'aria-label': t('board.column', { name: col.label, n: col.tasks.length }) },
      h('div', { class: 'bcol-head' },
        col.color ? h('span', { class: 'status-pill', style: { '--c': col.color } }) : null,
        group === 'assignee' ? avatar(col.assignee_id ? col.label : null, col.assignee_id) : null,
        group === 'priority' ? prioIcon(col.priority) : null,
        h('span', { class: 'ellipsis' }, col.label),
        h('span', { class: 'count' }, String(col.tasks.length))),
      body,
      canWork ? addInput(col) : null);
    if (canWork) {
      el.addEventListener('dragover', (e) => {
        if (!drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drop-target');
        placeIndicator(body, e.clientY);
      });
      el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) { el.classList.remove('drop-target'); removeIndicator(); } });
      el.addEventListener('drop', (e) => {
        if (!drag) return;
        e.preventDefault();
        const index = indicatorIndex(body);
        el.classList.remove('drop-target');
        removeIndicator();
        moveTo(drag.task, drag.from, col, index);
      });
    }
    return el;
  }

  // Cards in a column body (excluding the dragged one) and where the pointer
  // falls between them.
  function placeIndicator(body, y) {
    const cards = [...body.querySelectorAll('.bcard')].filter(x => !x.classList.contains('dragging'));
    const before = cards.find(x => { const r = x.getBoundingClientRect(); return y < r.top + r.height / 2; });
    if (!indicator) indicator = h('div', { class: 'bdrop', 'aria-hidden': 'true' });
    if (before) { if (indicator.nextSibling !== before) body.insertBefore(indicator, before); }
    else if (body.lastElementChild !== indicator) body.append(indicator);
  }
  function indicatorIndex(body) {
    if (!indicator || indicator.parentNode !== body) return null;
    let i = 0;
    for (const n of body.children) { if (n === indicator) return i; if (n.classList.contains('bcard') && !n.classList.contains('dragging')) i++; }
    return i;
  }
  function removeIndicator() { indicator?.remove(); }

  // ---- cards ---------------------------------------------------------------

  function card(tk, col) {
    const done = !!tk.completed_at;
    const moveBtn = canWork ? h('button', { class: 'btn ghost sm icon-only bmove', type: 'button', 'aria-label': t('board.move_menu', { title: tk.title }), title: t('board.move_to'),
      onclick: (e) => { e.stopPropagation(); moveMenu(e.currentTarget, tk, col); } }, icon('more', 14)) : null;
    const el = h('div', { class: ['bcard', done && 'done'], role: 'listitem', tabindex: '0', draggable: canWork ? 'true' : null, dataset: { id: tk.id },
      onkeydown: (e) => onCardKey(e, tk, col, el),
      ondragstart: (e) => {
        drag = { task: tk, from: col };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(tk.id));
        requestAnimationFrame(() => el.classList.add('dragging'));
      },
      ondragend: () => { drag = null; el.classList.remove('dragging'); removeIndicator(); board.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target')); },
    },
      h('div', { class: 'row gap-4 btop' },
        prioIcon(tk.priority),
        tk.is_milestone ? icon('diamond', 13) : null,
        h('span', { class: 'bt grow' }, tk.title),
        moveBtn),
      c.showProject && tk.project_id || tk.labels.length ? h('div', { class: 'row wrap gap-4' },
        c.showProject && tk.project_id ? h('span', { class: 'chip outline', title: tk.project_name }, tk.project_code || tk.project_name) : null,
        tk.labels.slice(0, 4).map(l => labelChip(l))) : null,
      h('div', { class: 'bm' },
        tk.due_date ? dueBadge(tk, { projectStart: c.project?.start_date || tk.project_start }) : null,
        tk.subtask_count ? h('span', { title: t('task.subtasks') }, icon('subtask', 12), ` ${tk.subtask_done}/${tk.subtask_count}`) : null,
        tk.checklist_total ? h('span', { title: t('task.checklist') }, icon('check', 12), ` ${tk.checklist_done}/${tk.checklist_total}`) : null,
        tk.comment_count ? h('span', { title: t('task.comments') }, icon('comment', 12), ` ${tk.comment_count}`) : null,
        tk.attachment_count ? h('span', { title: t('task.files') }, icon('clip', 12), ` ${tk.attachment_count}`) : null,
        tk.open_blockers ? h('span', { class: 'warn-text', title: t('task.waiting_on', { n: tk.open_blockers }) }, icon('lock', 12)) : null,
        h('span', { class: 'right' }, avatar(tk.assignee_name, tk.assignee_id))));
    el.addEventListener('click', (e) => { if (!e.target.closest('button, a, input')) c.open(tk.id); });
    return el;
  }

  function onCardKey(e, tk, col, el) {
    if (e.target !== el) return;
    if (e.key === 'Enter') { e.preventDefault(); c.open(tk.id); return; }
    if (canWork && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); moveMenu(el.querySelector('.bmove'), tk, col); return; }
    const ci = columns.indexOf(col), ti = col.tasks.indexOf(tk);
    let target = null;
    if (e.key === 'ArrowDown') target = cardEl(col, ti + 1);
    else if (e.key === 'ArrowUp') target = cardEl(col, ti - 1);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const step = e.key === 'ArrowRight' ? 1 : -1;
      for (let i = ci + step; i >= 0 && i < columns.length; i += step) {
        if (columns[i].tasks.length) { target = cardEl(columns[i], Math.min(ti, columns[i].tasks.length - 1)); break; }
      }
    }
    if (target) { e.preventDefault(); target.focus(); target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  function cardEl(col, i) { const tk = col.tasks[i]; return tk ? board.querySelector(`.bcard[data-id="${tk.id}"]`) : null; }

  function moveMenu(anchor, tk, col) {
    const i = col.tasks.indexOf(tk);
    openMenu(anchor, [
      ...(i > 0 ? [{ label: t('board.move_up'), onSelect: () => moveTo(tk, col, col, i - 1) }] : []),
      ...(i < col.tasks.length - 1 ? [{ label: t('board.move_down'), onSelect: () => moveTo(tk, col, col, i + 1) }] : []),
      { head: t('board.move_to') },
      ...columns.map(g => ({ label: g.label, checked: g === col, onSelect: () => { if (g !== col) moveTo(tk, col, g, null); } })),
    ], { search: columns.length > 8 });
  }

  // ---- moving --------------------------------------------------------------

  // Move `task` into column `to` at `index` among its other cards (null = end).
  async function moveTo(task, from, to, index) {
    const siblings = to.tasks.filter(x => x.id !== task.id);
    if (index == null || index > siblings.length) index = siblings.length;
    if (from === to && from.tasks.indexOf(task) === index) return;
    const patch = {};
    if (from !== to) {
      if (group === 'section') patch.section_id = to.section_id ?? null;
      if (group === 'status') patch.status = to.status;
      if (group === 'priority') patch.priority = to.priority;
      if (group === 'assignee') patch.assignee_id = to.assignee_id ?? null;
    }
    const prev = siblings[index - 1], next = siblings[index];
    patch.position = prev && next ? (prev.position + next.position) / 2 : next ? next.position - 1 : prev ? prev.position + 1 : 1;
    try { await c.update(task, patch); await c.reload(); } catch { return; }
    // Keep keyboard users where they were: focus the moved card again.
    requestAnimationFrame(() => {
      const again = document.querySelector(`.bcard[data-id="${task.id}"]`);
      if (again && document.activeElement === document.body) again.focus();
    });
  }

  // ---- inline add ----------------------------------------------------------

  function addInput(col) {
    const label = `${t('coll.add_task')} — ${col.label}`;
    const input = h('input', { class: 'input sm bare', placeholder: t('coll.add_task'), 'aria-label': label });
    input.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      const fields = { title: input.value.trim() };
      if (group === 'section') fields.section_id = col.section_id ?? null;
      if (group === 'status') fields.status = col.status;
      if (group === 'priority') fields.priority = col.priority;
      if (group === 'assignee') fields.assignee_id = col.assignee_id ?? null;
      input.value = '';
      input.disabled = true;
      try {
        await c.createTask(fields);
        requestAnimationFrame(() => [...document.querySelectorAll('.bcol-add input')].find(x => x.getAttribute('aria-label') === label)?.focus());
      } catch (err) { showError(err); input.value = fields.title; } finally { input.disabled = false; }
    });
    return h('div', { class: 'bcol-add' }, icon('plus', 13, 'muted'), input);
  }
}

// The user's own order wins on a board, so drag-to-reorder sticks; finished
// cards sink to the bottom.
function sortCards(tasks) {
  return [...tasks].sort((a, b) => (a.completed_at ? 1 : 0) - (b.completed_at ? 1 : 0) || a.position - b.position || a.id - b.id);
}
