// Search: tasks, projects, comments and people the viewer can see. The
// server marks matches with \u0002…\u0003; snippet() escapes the text and
// turns only those markers into <mark>, so this is the one html use here.

import { h, mount, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { t, entityById } from '../lib/state.js';
import { avatar, emptyState, spinner, statusPill, dueBadge, timeAgo, fmtDateTime } from '../lib/ui.js';
import { snippet } from '../lib/markdown.js';

// Mentions are stored as @[Name](user:ID); show them as @Name in snippets.
const cleanMentions = (s) => String(s || '').replace(/@\[([^\]]{1,120})\]\(user:\d+\)/g, '@$1');

export default async function search(root, params, query) {
  const q = (query.q || '').trim();
  const input = h('input', { class: 'input search-input', id: 'search-q', type: 'search', value: q, placeholder: t('search.page_placeholder'), autocomplete: 'off' });
  const results = h('div', { 'aria-live': 'polite' });
  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, q.length >= 2 ? t('search.results_for', { q }) : t('nav.search'))),
    h('form', { class: 'row mb-16', role: 'search', onsubmit: (e) => {
      e.preventDefault();
      const v = input.value.trim();
      location.hash = '#/search' + (v ? '?q=' + encodeURIComponent(v) : '');
    } },
      h('label', { class: 'sr-only', for: 'search-q' }, t('nav.search')),
      h('div', { class: 'search-field grow' }, icon('search', 15), input),
      h('button', { class: 'btn primary', type: 'submit' }, t('common.search'))),
    results));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);

  if (!q) { mount(results, h('div', { class: 'card' }, emptyState(t('search.prompt'), 'search'))); return; }
  if (q.length < 2) { mount(results, h('div', { class: 'card' }, emptyState(t('search.too_short'), 'search'))); return; }

  mount(results, spinner());
  let r;
  try { r = await api.get('/search', { q }); }
  catch (e) { mount(results, h('div', { class: 'banner danger' }, e.message || t('common.error'))); return; }

  const total = r.tasks.length + r.projects.length + r.comments.length + r.people.length;
  if (!total) { mount(results, h('div', { class: 'card' }, emptyState(t('search.no_results', { q }), 'search'))); return; }

  const section = (id, title, rows, render) => rows.length ? h('section', { class: 'mb-16', 'aria-labelledby': 'sr-' + id },
    h('h2', { id: 'sr-' + id, class: 'mb-8' }, title, ' ', h('span', { class: 'muted small' }, `(${rows.length})`)),
    h('ul', { class: 'card search-list' }, rows.map(render))) : null;

  const snip = (s) => s && /\u0002/.test(s) ? h('div', { class: 'small muted search-snippet', html: snippet(cleanMentions(s)) }) : null;

  mount(results,
    h('p', { class: 'muted small mb-16' }, t('search.summary', { n: total })),
    section('tasks', t('search.tasks'), r.tasks, (x) => h('li', { class: 'search-item' },
      h('div', { class: 'row' },
        icon(x.completed_at ? 'check' : 'tasks', 14, x.completed_at ? 'ok-text' : 'muted'),
        h('a', { class: ['grow', 'ellipsis', x.completed_at && 'muted'], href: `#/tasks/${x.id}`, title: x.title }, x.title),
        statusPill(x.status),
        dueBadge(x)),
      h('div', { class: 'row gap-4 xs muted', style: { paddingLeft: '22px' } },
        x.project_id ? h('span', { class: 'chip', title: x.project_name }, x.project_code || x.project_name) : h('span', { class: 'chip' }, t('task.personal'))),
      snip(x.snippet))),
    section('projects', t('search.projects'), r.projects, (x) => {
      const e = entityById(x.entity_id);
      return h('li', { class: 'search-item' }, h('div', { class: 'row' },
        icon('folder', 14),
        h('a', { class: 'grow ellipsis', href: `#/projects/${x.id}`, title: x.name }, x.code ? `${x.code} — ${x.name}` : x.name),
        e ? h('span', { class: 'chip', title: e.name, style: { background: (e.color || '#888') + '22', color: e.color } }, e.code) : null,
        h('span', { class: ['chip', x.status === 'active' ? 'ok' : ''] }, t('project.status_' + x.status))));
    }),
    section('comments', t('search.comments'), r.comments, (x) => h('li', { class: 'search-item' },
      h('div', { class: 'row' },
        icon('comment', 14),
        h('a', { class: 'grow ellipsis', href: `#/tasks/${x.object_id}`, title: x.task_title }, t('search.comment_on', { who: x.author_name, title: x.task_title || '' })),
        h('time', { class: 'muted xs nowrap', datetime: x.created_at, title: fmtDateTime(x.created_at) }, timeAgo(x.created_at))),
      x.project_name ? h('div', { class: 'xs muted', style: { paddingLeft: '22px' } }, x.project_name) : null,
      snip(x.snippet))),
    section('people', t('search.people'), r.people, (x) => {
      const e = entityById(x.entity_id);
      return h('li', { class: 'search-item' }, h('div', { class: 'row' },
        avatar(x.name, x.id),
        h('a', { class: 'ellipsis', href: `#/people/${x.id}` }, x.name),
        h('span', { class: 'muted small grow ellipsis' }, [x.title, x.email].filter(Boolean).join(' · ')),
        e ? h('span', { class: 'chip', title: e.name }, e.code) : null));
    }));
}
