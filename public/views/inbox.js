// Inbox: everything addressed to me — assignments, mentions, comments,
// reminders. Inbox / Unread / Archived; opening an item marks it read.

import { h, mount, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t, emit, local } from '../lib/state.js';
import { showError, toast, avatar, emptyState, spinner, timeAgo, fmtDateTime } from '../lib/ui.js';
import { plain } from '../lib/markdown.js';

const BOXES = ['inbox', 'unread', 'archived'];

export default async function inbox(root, params, query) {
  let box = BOXES.includes(query.box) ? query.box : local.get('inbox.box', 'inbox');
  let offset = 0;
  const items = new Map(); // id → notification
  const list = h('ul', { class: 'inbox-list', 'aria-label': t('nav.inbox') });
  const more = h('button', { class: 'btn sm mt-8 hidden', onclick: () => load(false) }, t('common.load_more'));
  const counter = h('span', { class: 'sub', 'aria-live': 'polite' });
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('inbox.boxes') });
  const listWrap = h('div', { class: 'card inbox-card', id: 'inbox-panel', role: 'tabpanel' });

  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.inbox')), counter,
      h('div', { class: 'right row wrap gap-4' },
        h('button', { class: 'btn sm', onclick: async () => {
          try { await api.post('/notifications/read-all'); setUnread(0); toast(t('inbox.all_read')); load(true); } catch (e) { showError(e); }
        } }, icon('check', 13), t('inbox.mark_all_read')),
        h('button', { class: 'btn sm', onclick: async () => {
          try { const r = await api.post('/notifications/archive-read'); toast(t('inbox.archived_n', { n: r.updated })); load(true); } catch (e) { showError(e); }
        } }, icon('archive', 13), t('inbox.archive_read')))),
    tabs, listWrap, more,
    h('p', { class: 'muted xs mt-16' }, t('inbox.keys_hint'), ' ', h('a', { href: '#/settings' }, t('inbox.prefs_link')))));

  const renderTabs = () => mount(tabs, BOXES.map(b => h('button', { role: 'tab', 'aria-selected': String(b === box), id: 'inbox-tab-' + b, 'aria-controls': 'inbox-panel',
    onclick: () => { box = b; local.set('inbox.box', b); renderTabs(); load(true); } },
    { inbox: t('inbox.tab_inbox'), unread: t('inbox.tab_unread'), archived: t('inbox.tab_archived') }[b])));

  function setUnread(n) {
    state.unread = n;
    counter.textContent = n ? t('inbox.unread_n', { n }) : t('inbox.all_caught_up');
    emit('unread:changed', n);
  }
  async function refreshCount() {
    try { setUnread((await api.get('/notifications/count')).unread); } catch { /* the poll in the shell will catch up */ }
  }

  function row(n) {
    const unread = !n.read_at;
    const sentence = t('notif.' + n.kind, { who: n.actor_name || t('common.someone'), title: n.title || '' });
    const open = async (e) => {
      e.preventDefault();
      if (unread) { try { await api.post(`/notifications/${n.id}/read`); n.read_at = new Date().toISOString(); replace(n); refreshCount(); } catch { /* still navigate */ } }
      if (n.url && n.url.startsWith('#/')) location.hash = n.url;
      else replace(n);
    };
    const act = (label, iconName, fn) => h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${label}: ${sentence}`, title: label, onclick: async (e) => { e.stopPropagation(); try { await fn(); } catch (err) { showError(err); } } }, icon(iconName, 14));
    const li = h('li', { class: ['inbox-item', unread && 'unread'], dataset: { id: n.id } },
      h('span', { class: 'inbox-dot', 'aria-hidden': 'true' }),
      n.actor_name ? avatar(n.actor_name, n.actor_id) : h('span', { class: 'avatar inbox-sys', 'aria-hidden': 'true' }, icon('bell', 12)),
      h('a', { class: 'inbox-main', href: n.url || '#/inbox', onclick: open },
        h('span', { class: 'sr-only' }, unread ? t('inbox.unread_label') + ': ' : ''),
        h('span', { class: 'inbox-sentence' }, sentence),
        n.body ? h('span', { class: 'inbox-body muted small' }, plain(n.body, 160)) : null,
        h('span', { class: 'row gap-4 xs muted inbox-meta' },
          n.project_code || n.project_name ? h('span', { class: 'chip', title: n.project_name || '' }, n.project_code || n.project_name) : null,
          h('time', { datetime: n.created_at, title: fmtDateTime(n.created_at) }, timeAgo(n.created_at)))),
      h('span', { class: 'inbox-actions' },
        n.archived_at ? null : unread
          ? act(t('inbox.mark_read'), 'check', async () => { await api.post(`/notifications/${n.id}/read`); n.read_at = new Date().toISOString(); after(n); })
          : act(t('inbox.mark_unread'), 'eye', async () => { await api.post(`/notifications/${n.id}/unread`); n.read_at = null; after(n); }),
        n.archived_at ? null : act(t('inbox.archive'), 'archive', async () => {
          await api.post(`/notifications/${n.id}/archive`);
          n.archived_at = new Date().toISOString();
          if (!n.read_at) n.read_at = n.archived_at;
          after(n, true);
          toast(t('inbox.archived_one'));
        })));
    return li;
  }

  function replace(n) {
    const old = list.querySelector(`[data-id="${n.id}"]`);
    if (old) { const fresh = row(n); old.replaceWith(fresh); return fresh; }
    return null;
  }
  // After a per-item change: drop it from views it no longer belongs to.
  function after(n, archived = false) {
    const gone = (archived && box !== 'archived') || (box === 'unread' && n.read_at);
    if (gone) {
      const el = list.querySelector(`[data-id="${n.id}"]`);
      const next = el?.nextElementSibling || el?.previousElementSibling;
      el?.remove();
      items.delete(n.id);
      next?.querySelector('.inbox-main')?.focus();
      if (!items.size) mount(list, h('li', null, emptyLine()));
    } else {
      replace(n)?.querySelector('.inbox-actions button')?.focus();
    }
    refreshCount();
  }

  const emptyLine = () => emptyState({ inbox: t('inbox.empty_inbox'), unread: t('inbox.empty_unread'), archived: t('inbox.empty_archived') }[box], 'inbox');

  async function load(reset) {
    if (reset) { offset = 0; items.clear(); mount(listWrap, spinner()); }
    try {
      const r = await api.list('/notifications', { box, limit: 50, offset });
      if (reset) { list.replaceChildren(); mount(listWrap, list); }
      listWrap.setAttribute('aria-labelledby', 'inbox-tab-' + box);
      for (const n of r.data) { items.set(n.id, n); list.append(row(n)); }
      if (!items.size) mount(list, h('li', null, emptyLine()));
      offset = r.meta.next_offset ?? offset;
      more.classList.toggle('hidden', r.meta.next_offset == null);
      if (r.meta.unread !== undefined) setUnread(r.meta.unread);
    } catch (e) { mount(listWrap, h('div', { class: 'banner danger' }, e.message || t('common.error'))); }
  }

  // j / k move between items; Enter opens (it is a link); e archives.
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!['j', 'k', 'e'].includes(e.key)) return;
    const links = [...list.querySelectorAll('.inbox-main')];
    if (!links.length) return;
    const cur = links.indexOf(document.activeElement.closest?.('.inbox-item')?.querySelector('.inbox-main'));
    if (e.key === 'e') {
      if (cur < 0) return;
      const btn = links[cur].closest('.inbox-item').querySelector('[aria-label^="' + t('inbox.archive') + '"]');
      btn?.click();
    } else {
      const next = e.key === 'j' ? Math.min(cur + 1, links.length - 1) : Math.max(cur - 1, 0);
      links[cur < 0 ? 0 : next].focus();
    }
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  renderTabs();
  setUnread(state.unread || 0);
  await load(true);
  return () => document.removeEventListener('keydown', onKey);
}
