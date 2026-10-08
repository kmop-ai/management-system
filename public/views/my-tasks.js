// My Tasks: everything assigned to me, across projects and personal tasks,
// grouped Overdue / Today / This week / Later / No date by default.

import { h, mount, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t, on } from '../lib/state.js';
import { taskCollection } from '../lib/collection.js';

export default async function myTasks(root) {
  const summary = h('div', { class: 'row gap-16 small muted' });
  const body = h('div');
  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.my_tasks')), summary),
    body));

  async function loadSummary() {
    try {
      const r = await api.get('/my-tasks');
      const b = r.buckets;
      mount(summary,
        b.overdue.length ? h('span', { class: 'danger-text' }, icon('alert', 13), ' ', t('my.overdue_n', { n: b.overdue.length })) : null,
        h('span', null, t('my.today_n', { n: b.today.length })),
        h('span', null, t('my.week_n', { n: b.upcoming.length })),
        b.done_today.length ? h('span', { class: 'ok-text' }, icon('check', 13), ' ', t('my.done_n', { n: b.done_today.length })) : null);
    } catch {}
  }
  loadSummary();
  const off = on('task:changed', () => loadSummary());

  const cleanup = taskCollection(body, {
    scope: 'my_tasks',
    base: { assignee: 'me' },
    views: ['list', 'board', 'calendar'],
    defaultFilters: { state: 'recent' },
    showProject: true,
  });
  return () => { off(); cleanup(); };
}
