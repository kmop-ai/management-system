// Month calendar renderer for a task collection: Monday-first 6-week grid,
// tasks on their due date, drag a task to another day to reschedule it,
// click a day (or its "+") to add a task due that day.
// Keyboard: days are a grid — arrow keys move between days (crossing into the
// next/previous month), PageUp/PageDown change month, Enter lists the day's
// tasks (and offers "add"), N adds a task on the focused day.

import { h, mount, icon, todayStr, parseDate, fmtISO, addDays, daysBetween, mondayOf } from '../lib/dom.js';
import { state, t, local } from '../lib/state.js';
import { openMenu, formDialog } from '../lib/ui.js';

const PRIO = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export default function renderCalendar(el, c) {
  const canWork = !c.project || c.project.access?.work;
  const key = 'cal.month.' + (c.scope || 'default');
  const today = todayStr();
  const intl = state.locale === 'el' ? 'el-GR' : 'en-GB';
  const fmtTitle = new Intl.DateTimeFormat(intl, { month: 'long', year: 'numeric' });
  const fmtDay = new Intl.DateTimeFormat(intl, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const fmtWeekday = new Intl.DateTimeFormat(intl, { weekday: 'short' });
  const fmtShort = new Intl.DateTimeFormat(intl, { day: 'numeric', month: 'long' });
  const narrow = () => window.matchMedia('(max-width: 600px)').matches;

  let month = local.get(key, today.slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) month = today.slice(0, 7);
  let focusDate = null;  // date to focus after a re-render (keyboard navigation)
  let dragTask = null;

  // Tasks by due date.
  const byDay = new Map();
  let undated = 0;
  for (const tk of c.tasks) {
    if (!tk.due_date) { undated++; continue; }
    if (!byDay.has(tk.due_date)) byDay.set(tk.due_date, []);
    byDay.get(tk.due_date).push(tk);
  }
  for (const list of byDay.values()) list.sort((a, b) => (a.completed_at ? 1 : 0) - (b.completed_at ? 1 : 0) || PRIO[a.priority] - PRIO[b.priority] || a.title.localeCompare(b.title));

  const title = h('h2', { class: 'cal-title', 'aria-live': 'polite' });
  const bar = h('div', { class: 'cal-bar' },
    h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': t('cal.prev_month'), title: t('cal.prev_month'), onclick: () => go(-1) }, icon('chevronLeft', 14)),
    h('button', { class: 'btn sm', type: 'button', onclick: () => { month = today.slice(0, 7); focusDate = null; render(); } }, t('common.today')),
    h('button', { class: 'btn sm icon-only', type: 'button', 'aria-label': t('cal.next_month'), title: t('cal.next_month'), onclick: () => go(1) }, icon('chevronRight', 14)),
    title,
    h('span', { class: 'muted xs hide-mobile right' }, t('cal.keys_hint')));
  const grid = h('div', { class: 'cal calx', role: 'grid' });
  const note = h('div', { class: 'muted xs mt-8' });
  mount(el, bar, grid, note);

  function go(n) {
    const d = parseDate(month + '-01');
    d.setMonth(d.getMonth() + n);
    month = fmtISO(d).slice(0, 7);
    render();
  }

  function render() {
    local.set(key, month);
    const first = month + '-01';
    title.textContent = capitalise(fmtTitle.format(parseDate(first)));
    title.id = 'cal-title-' + Math.random().toString(36).slice(2, 7);
    grid.setAttribute('aria-labelledby', title.id);
    const start = mondayOf(first);
    const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
    const focusable = focusDate && days.includes(focusDate) ? focusDate : days.includes(today) && today.startsWith(month) ? today : first;

    const head = h('div', { class: 'cal-head', role: 'row' },
      days.slice(0, 7).map(d => h('div', { role: 'columnheader' }, fmtWeekday.format(parseDate(d)))));
    const body = h('div', { class: 'cal-grid' });
    for (let w = 0; w < 6; w++) {
      body.append(h('div', { role: 'row', class: 'cal-week' }, days.slice(w * 7, w * 7 + 7).map(d => dayCell(d, d === focusable))));
    }
    mount(grid, head, body);
    note.textContent = undated ? t('cal.undated', { n: undated }) : '';
    if (focusDate) { grid.querySelector(`.cal-day[data-date="${focusDate}"]`)?.focus(); focusDate = null; }
  }

  function dayCell(d, isFocusable) {
    const tasks = byDay.get(d) || [];
    const other = !d.startsWith(month);
    const max = 3;
    const shown = tasks.length > max ? tasks.slice(0, max - 1) : tasks;
    const rest = tasks.length - shown.length;
    const label = (d === today ? t('common.today') + ', ' : '') + fmtDay.format(parseDate(d)) + ', ' + (tasks.length ? t('cal.n_tasks', { n: tasks.length }) : t('cal.no_tasks'));
    const cell = h('div', { class: ['cal-day', other && 'other', d === today && 'today'], role: 'gridcell', tabindex: isFocusable ? '0' : '-1', 'aria-label': label, dataset: { date: d },
      onkeydown: (e) => onDayKey(e, d, cell),
      onclick: (e) => {
        if (e.target.closest('.cal-ev, .cal-more, .cal-add')) return;
        if (narrow() && tasks.length) dayMenu(cell, d);
        else if (canWork) addTask(d);
      },
    },
      h('div', { class: 'cal-dh' },
        h('span', { class: 'dn', 'aria-hidden': 'true' }, String(parseDate(d).getDate())),
        canWork ? h('button', { class: 'cal-add', type: 'button', tabindex: '-1', 'aria-label': t('cal.add_on', { date: fmtShort.format(parseDate(d)) }), title: t('cal.add_on', { date: fmtShort.format(parseDate(d)) }),
          onclick: (e) => { e.stopPropagation(); addTask(d); } }, icon('plus', 12)) : null),
      shown.map(tk => eventBtn(tk)),
      rest > 0 ? h('button', { class: 'cal-more', type: 'button', tabindex: '-1', onclick: (e) => { e.stopPropagation(); dayMenu(e.currentTarget, d); } }, t('common.n_more', { n: rest })) : null);
    if (canWork) {
      cell.addEventListener('dragover', (e) => { if (dragTask) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; cell.classList.add('drop-target'); } });
      cell.addEventListener('dragleave', (e) => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('drop-target'); });
      cell.addEventListener('drop', (e) => {
        cell.classList.remove('drop-target');
        if (!dragTask) return;
        e.preventDefault();
        const tk = dragTask; dragTask = null;
        moveTask(tk, d);
      });
    }
    return cell;
  }

  function eventState(tk) {
    if (tk.completed_at) return 'done';
    if (tk.due_date < today) return 'overdue';
    return '';
  }

  function eventLabel(tk) {
    const s = eventState(tk);
    return s === 'done' ? t('cal.ev_done', { title: tk.title }) : s === 'overdue' ? t('cal.ev_overdue', { title: tk.title }) : tk.title;
  }

  function eventBtn(tk) {
    const s = eventState(tk);
    const b = h('button', { class: ['cal-ev', 'cal-evx', s, c.showProject && tk.project_color && 'proj'], type: 'button', tabindex: '-1', draggable: canWork ? 'true' : null,
      style: c.showProject && tk.project_color ? { '--pc': tk.project_color } : null,
      title: [eventLabel(tk), c.showProject ? tk.project_code || tk.project_name || t('task.personal') : null, tk.assignee_name].filter(Boolean).join(' · '),
      'aria-label': eventLabel(tk),
      onclick: (e) => { e.stopPropagation(); c.open(tk.id); },
      ondragstart: (e) => { dragTask = tk; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(tk.id)); b.classList.add('dragging'); },
      ondragend: () => { dragTask = null; b.classList.remove('dragging'); grid.querySelectorAll('.drop-target').forEach(x => x.classList.remove('drop-target')); },
    }, tk.is_milestone ? icon('diamond', 10) : null, h('span', { class: 'ellipsis' }, tk.title));
    return b;
  }

  function onDayKey(e, d, cell) {
    if (e.target !== cell) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (moves[e.key]) {
      e.preventDefault();
      const n = addDays(d, moves[e.key]);
      const target = grid.querySelector(`.cal-day[data-date="${n}"]`);
      if (target && n.startsWith(month)) { cell.tabIndex = -1; target.tabIndex = 0; target.focus(); }
      else { month = n.slice(0, 7); focusDate = n; render(); }
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      const dt = parseDate(d); dt.setMonth(dt.getMonth() + (e.key === 'PageUp' ? -1 : 1));
      focusDate = fmtISO(dt); month = focusDate.slice(0, 7); render();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if ((byDay.get(d) || []).length) dayMenu(cell, d);
      else if (canWork) addTask(d);
    } else if ((e.key === 'n' || e.key === 'N') && canWork && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); addTask(d);
    }
  }

  // Every task of one day as a keyboard menu, plus "add".
  function dayMenu(anchor, d) {
    const tasks = byDay.get(d) || [];
    openMenu(anchor, [
      { head: capitalise(fmtDay.format(parseDate(d))) },
      ...tasks.map(tk => ({ label: tk.title, icon: tk.completed_at ? 'check' : eventState(tk) === 'overdue' ? 'alert' : tk.is_milestone ? 'diamond' : 'tasks',
        hint: c.showProject ? (tk.project_code || '') : (tk.assignee_name || ''), onSelect: () => c.open(tk.id) })),
      ...(canWork ? [{ sep: true }, { label: t('cal.add_on', { date: fmtShort.format(parseDate(d)) }), icon: 'plus', onSelect: () => addTask(d) }] : []),
    ], { width: 260 });
  }

  function addTask(d) {
    formDialog({
      title: t('cal.new_task'),
      intro: h('p', { class: 'muted small' }, t('cal.due_on', { date: capitalise(fmtDay.format(parseDate(d))) })),
      submitLabel: t('common.create'),
      fields: [{ name: 'title', label: t('common.title'), required: true }],
      onSubmit: async (v) => { await c.createTask({ title: v.title.trim(), due_date: d }); },
    });
  }

  async function moveTask(tk, d) {
    if (tk.due_date === d) return;
    const shift = daysBetween(tk.due_date, d);
    const patch = { due_date: d };
    if (tk.start_date) patch.start_date = addDays(tk.start_date, shift);
    try { await c.update(tk, patch); await c.reload(); } catch {}
  }

  render();
}

const capitalise = (s) => s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
