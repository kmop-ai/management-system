// Calendar: my tasks across projects, by due date, in a month grid.

import { h, mount } from '../lib/dom.js';
import { t } from '../lib/state.js';
import { taskCollection } from '../lib/collection.js';

export default async function calendar(root) {
  const body = h('div');
  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.calendar'))),
    body));
  return taskCollection(body, {
    scope: 'calendar',
    base: { assignee: 'me' },
    views: ['calendar', 'list'],
    defaultView: 'calendar',
    defaultFilters: { state: 'all' },
    showProject: true,
  });
}
