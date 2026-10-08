// KMOP HQ — SPA shell: boot, hash router, navigation, global shortcuts.
//
// Views live in /views/*.js and export `default async function (root,
// params, query)`. They may return a cleanup function. Routes are hashes so
// the Worker serves one index.html and deep links work from email.

import { h, mount, icon } from './lib/dom.js';
import { api, setUnauthorizedHandler } from './lib/api.js';
import { state, setBootstrap, t, can, local, on } from './lib/state.js';
import { toast, spinner } from './lib/ui.js';

const ROUTES = [
  ['/auth/verify', () => import('./views/login.js'), 'verify', { public: true }],
  ['/login', () => import('./views/login.js'), 'login', { public: true }],
  ['/', () => import('./views/my-tasks.js')],
  ['/inbox', () => import('./views/inbox.js')],
  ['/my-tasks', () => import('./views/my-tasks.js')],
  ['/projects', () => import('./views/projects.js')],
  ['/projects/:id', () => import('./views/project.js')],
  ['/projects/:id/:tab', () => import('./views/project.js')],
  ['/workload', () => import('./views/workload.js')],
  ['/calendar', () => import('./views/calendar.js')],
  ['/people', () => import('./views/people.js')],
  ['/people/:id', () => import('./views/person.js')],
  ['/templates', () => import('./views/templates.js')],
  ['/templates/:id', () => import('./views/templates.js')],
  ['/search', () => import('./views/search.js')],
  ['/admin', () => import('./views/admin.js')],
  ['/admin/:tab', () => import('./views/admin.js')],
  ['/audit', () => import('./views/audit.js')],
  ['/settings', () => import('./views/settings.js')],
  ['/team', () => import('./views/team.js')],
  ['/team/:tab', () => import('./views/team.js')],
  ['/help', () => import('./views/help.js')],
];

// Which module a route belongs to. Without that module the page does not
// exist for the person (they get "not found", never a locked page).
const ROUTE_MODULE = [
  [/^\/projects/, 'projects'], [/^\/templates/, 'projects'],
  [/^\/(my-tasks|calendar|workload)$/, 'tasks'],
  [/^\/(team|admin|audit|people)/, 'team'],
];
function moduleFor(path) { for (const [re, m] of ROUTE_MODULE) if (re.test(path)) return m; return null; }

const compiled = ROUTES.map(([path, load, named, opts = {}]) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { path, load, named, opts, re, keys };
});

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

let cleanup = null;
let shellEls = null;
let baseHash = '#/my-tasks';   // the view under the task drawer
let renderSeq = 0;

async function route() {
  const { path, query } = parseHash();

  // The task drawer is an overlay: keep (or create) the view underneath.
  const tm = /^\/tasks\/(\d+)$/.exec(path);
  if (tm) {
    if (!state.me) return boot();
    if (!shellEls) renderShell();
    if (!shellEls.content.dataset.rendered) await renderView(baseHash.replace(/^#/, '').split('?')[0], {}, true);
    const { openTaskDrawer } = await import('./lib/task-drawer.js');
    openTaskDrawer(Number(tm[1]), { onClose: () => { if (location.hash.startsWith('#/tasks/')) location.hash = baseHash; } });
    return;
  }
  const { closeTaskDrawer } = await import('./lib/task-drawer.js');
  closeTaskDrawer(true);
  // A dialog belongs to the page that opened it.
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  baseHash = location.hash || '#/my-tasks';
  await renderView(path, query);
}

async function renderView(path, query, underlay = false) {
  const r = compiled.find(x => x.re.test(path)) || compiled.find(x => x.path === '/');
  const m = r.re.exec(path) || [];
  const params = {};
  r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  if (!r.opts.public && !state.me) { location.hash = '#/login?next=' + encodeURIComponent(location.hash); return; }
  const seq = ++renderSeq;
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }

  if (r.opts.public) {
    shellEls = null;
    const app = document.getElementById('app');
    const mod = await r.load();
    if (seq !== renderSeq) return;
    cleanup = await mod.default(app, { ...params, mode: r.named }, query) || null;
    return;
  }
  // Home is the first page in the person's own sidebar.
  if (path === '/' && state.nav?.length && state.nav[0].route !== '#/') { location.replace('#' + state.nav[0].route.slice(1)); return; }
  if (!shellEls) renderShell();
  highlightNav(path);
  const content = shellEls.content;
  const needed = moduleFor(path);
  if (needed && !state.access?.modules?.[needed]) {
    mount(content, h('div', { class: 'page' }, h('div', { class: 'banner' }, t('common.not_found'))));
    return;
  }
  mount(content, spinner());
  try {
    const mod = await r.load();
    if (seq !== renderSeq) return;
    const page = h('div');
    mount(content, page);
    content.dataset.rendered = '1';
    const c = await mod.default(page, params, query);
    if (seq !== renderSeq) { if (typeof c === 'function') c(); return; }
    cleanup = typeof c === 'function' ? c : null;
    if (!underlay) content.scrollTop = 0;
    const heading = page.querySelector('h1');
    document.title = (heading ? heading.textContent + ' · ' : '') + 'KMOP HQ';
  } catch (e) {
    if (seq !== renderSeq) return;
    mount(content, h('div', { class: 'page' }, h('div', { class: 'banner danger' }, e.status === 404 ? t('common.not_found') : e.status === 403 ? t('common.forbidden') : (e.message || t('common.error')))));
    if (!e.status) console.error(e);
  }
  shellEls.root.classList.remove('nav-open');
}

// ---- shell ----------------------------------------------------------------

function navItem(href, iconName, label, extra) {
  return h('a', { class: 'nav-item', href, dataset: { nav: href } }, icon(iconName, 16), h('span', { class: 'ellipsis' }, label), extra || null);
}

function renderShell() {
  const unread = h('span', { class: ['count', !state.unread && 'hidden'] }, String(state.unread || ''));
  const navEl = h('nav', { 'aria-label': t('nav.menu') });
  const nav = navEl;
  const projectsNav = h('div');
  const search = h('input', { class: 'input', type: 'search', placeholder: t('search.placeholder'), 'aria-label': t('nav.search'),
    onkeydown: (e) => { if (e.key === 'Enter' && search.value.trim()) location.hash = '#/search?q=' + encodeURIComponent(search.value.trim()); } });
  const content = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  const root = h('div', { class: 'shell' },
    h('a', { class: 'skip-link', href: '#main', onclick: (e) => { e.preventDefault(); content.focus(); } }, t('nav.skip')),
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'K'), 'KMOP HQ'),
      nav,
      h('div', { class: 'foot' },
        h('button', { class: 'btn ghost icon-only', title: t('nav.reorder'), 'aria-label': t('nav.reorder'), onclick: () => reorderSidebar() }, icon('list', 16)),
        h('a', { class: 'nav-item grow', href: '#/settings', dataset: { nav: '#/settings' } }, icon('user', 16), h('span', { class: 'ellipsis' }, state.me.name)),
        h('button', { class: 'btn ghost icon-only', title: t('nav.theme'), 'aria-label': t('nav.theme'), onclick: cycleTheme }, icon('moon', 16)),
      )),
    h('div', { class: 'main' },
      h('header', { class: 'topbar' },
        h('button', { class: 'btn ghost icon-only menu-btn', 'aria-label': t('nav.menu'), onclick: () => root.classList.toggle('nav-open') }, icon('menu')),
        h('div', { class: 'search-box' }, icon('search', 15), search),
        h('div', { class: 'right row' },
          h('a', { class: 'btn ghost icon-only', href: '#/inbox', 'aria-label': t('nav.inbox'), title: t('nav.inbox'), style: { position: 'relative' } }, icon('bell', 16), unread),
          state.access?.modules?.tasks === 'write' ? h('button', { class: 'btn primary', onclick: () => quickAdd(), title: t('nav.quick_add') + ' (Q)' }, icon('plus', 15), h('span', { class: 'hide-mobile' }, t('nav.quick_add'))) : null,
          h('button', { class: 'btn ghost icon-only', 'aria-label': t('nav.shortcuts'), title: t('nav.shortcuts') + ' (?)', onclick: showShortcuts }, '?'),
        )),
      content));
  root.addEventListener('click', (e) => { if (e.target === root && root.classList.contains('nav-open')) root.classList.remove('nav-open'); });
  mount(document.getElementById('app'), root);
  shellEls = { root, content, unread, projectsNav, search, nav: navEl };
  renderSidebar();
}

// The sidebar is built from module access (state.nav, computed by the
// server): three levels only — group, page, and tabs inside a record.
const PAGE_ICONS = { dashboard: 'home', projects: 'folder', ka1: 'globe', proposals: 'template', calls: 'calendar', partners: 'people',
  organisations: 'archive', people: 'user', reporting: 'chart', evaluation: 'star', tasks: 'tasks', team: 'shield', help: 'comment' };
function renderSidebar() {
  if (!shellEls) return;
  const items = [];
  let lastGroup = null;
  for (const p of state.nav || []) {
    if (p.group !== lastGroup && !['main', 'work', 'system'].includes(p.group)) items.push(h('div', { class: 'nav-heading' }, t('navgroup.' + p.group)));
    else if (p.group !== lastGroup && lastGroup !== null) items.push(h('div', { class: 'nav-sep' }));
    lastGroup = p.group;
    items.push(navItem(p.route, PAGE_ICONS[p.key] || 'more', t('page.' + p.key)));
  }
  mount(shellEls.nav, items);
  highlightNav(parseHash().path);
}

// Reorder my sidebar; saved to my profile.
async function reorderSidebar() {
  const { modal } = await import('./lib/ui.js');
  let order = (state.nav || []).map(p => p.key);
  const list = h('ol', { class: 'reorder-list' });
  const draw = () => mount(list, order.map((k, i) => h('li', { class: 'row' },
    h('span', { class: 'grow' }, t('page.' + k)),
    h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('nav.move_up') + ' ' + t('page.' + k), disabled: i === 0, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); list.querySelectorAll('button')[Math.max(0, (i - 1) * 2)]?.focus(); } }, '↑'),
    h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('nav.move_down') + ' ' + t('page.' + k), disabled: i === order.length - 1, onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; draw(); } }, '↓'))));
  draw();
  const m = modal({ title: t('nav.reorder'), body: h('div', null, h('p', { class: 'muted small' }, t('nav.reorder_hint')), list), footer: [
    h('button', { class: 'btn', onclick: () => { order = []; save(); } }, t('nav.reorder_reset')),
    h('button', { class: 'btn primary', onclick: () => save() }, t('common.save'))] });
  async function save() {
    try { state.nav = await api.put('/me/sidebar', { order }); renderSidebar(); m.close(); } catch (e) { (await import('./lib/ui.js')).showError(e); }
  }
}

export async function loadProjectsNav() {
  if (!shellEls) return;
  try {
    const r = await api.list('/projects', { member: 'me', limit: 30, sort: 'name' });
    mount(shellEls.projectsNav, r.data.map(p => h('a', { class: 'nav-item nav-project', href: `#/projects/${p.id}`, dataset: { nav: `#/projects/${p.id}` }, title: p.name },
      h('span', { class: 'dot', style: { background: p.color || 'var(--text-3)' } }), h('span', { class: 'ellipsis' }, p.code || p.name))));
    highlightNav(parseHash().path);
  } catch (e) { /* the sidebar is not worth an error toast */ }
}

function highlightNav(path) {
  if (!shellEls) return;
  for (const a of shellEls.root.querySelectorAll('.nav-item[data-nav]')) {
    const target = a.dataset.nav.replace(/^#/, '');
    const current = target === path || (target !== '/' && path.startsWith(target + '/')) || (path === '/' && target === '/my-tasks');
    if (current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

export function setUnread(n) {
  state.unread = n;
  if (!shellEls) return;
  shellEls.unread.textContent = String(n || '');
  shellEls.unread.classList.toggle('hidden', !n);
}

function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  const cur = document.documentElement.dataset.theme || 'system';
  const next = order[(order.indexOf(cur) + 1) % 3];
  applyTheme(next);
  api.patch('/me', { theme: next }).then(u => { if (u) Object.assign(state.me, u); }).catch(() => {});
  toast(t('settings.theme_' + next));
}

export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  local.set('theme', theme);
  try { localStorage.setItem('kmop.theme', theme); } catch {}
}

// ---- quick add (Q) --------------------------------------------------------

async function quickAdd(defaults = {}) {
  const { quickAddDialog } = await import('./lib/task-drawer.js');
  quickAddDialog(defaults);
}

// ---- keyboard shortcuts ---------------------------------------------------

const SHORTCUTS = [
  ['/', 'shortcut.search'], ['Q', 'shortcut.quick_add'], ['G I', 'shortcut.inbox'], ['G M', 'shortcut.my_tasks'],
  ['G P', 'shortcut.projects'], ['G W', 'shortcut.workload'], ['G C', 'shortcut.calendar'], ['Esc', 'shortcut.close'], ['?', 'shortcut.help'],
];

function showShortcuts() {
  import('./lib/ui.js').then(({ modal }) => modal({
    title: t('nav.shortcuts'),
    body: h('table', { class: 'table' }, h('tbody', null, SHORTCUTS.map(([k, label]) => h('tr', null, h('td', null, k.split(' ').map(x => h('span', { class: 'kbd' }, x))), h('td', null, t(label)))))),
  }));
}

let gPending = false;
document.addEventListener('keydown', (e) => {
  if (!state.me || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
  if (document.querySelector('dialog[open]') || document.querySelector('.menu')) return;
  const k = e.key.toLowerCase();
  if (gPending) {
    gPending = false;
    const map = { i: '#/inbox', m: '#/my-tasks', p: '#/projects', w: '#/workload', c: '#/calendar' };
    if (map[k]) { location.hash = map[k]; e.preventDefault(); }
    return;
  }
  if (k === 'g') { gPending = true; setTimeout(() => { gPending = false; }, 1200); return; }
  if (k === '/') { e.preventDefault(); shellEls?.search.focus(); return; }
  if (k === 'q') { e.preventDefault(); quickAdd(); return; }
  if (e.key === '?') { e.preventDefault(); showShortcuts(); }
});

// ---- boot -----------------------------------------------------------------

async function boot() {
  setUnauthorizedHandler(() => {
    state.me = null;
    if (!location.hash.startsWith('#/login') && !location.hash.startsWith('#/auth')) location.hash = '#/login?next=' + encodeURIComponent(location.hash);
  });
  const { path } = parseHash();
  const isPublic = path.startsWith('/auth/') || path === '/login';
  if (!state.me && !isPublic) {
    try {
      setBootstrap(await api.get('/me'));
      applyTheme(state.me.theme);
    } catch (e) {
      if (e.status !== 401) { mount(document.getElementById('app'), h('div', { class: 'auth-wrap' }, h('div', { class: 'banner danger' }, t('common.error'), ' — ', e.message))); return; }
      return; // the unauthorized handler redirected to #/login
    }
  }
  route();
}

export async function reloadBootstrap() {
  setBootstrap(await api.get('/me'));
  shellEls = null;
}

window.addEventListener('hashchange', () => route());
on('signed-in', async () => { await reloadBootstrap(); });
on('unread:changed', (n) => setUnread(n));
on('projects:changed', () => loadProjectsNav());

// Unread count: cheap poll while the tab is visible.
setInterval(async () => {
  if (!state.me || document.hidden) return;
  try { setUnread((await api.get('/notifications/count')).unread); } catch {}
}, 60000);

boot();

export { route, quickAdd };
