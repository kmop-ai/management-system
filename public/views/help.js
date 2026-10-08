// How to use this — written as the system is built; one section per part.
// Text lives in the shared string table (EN + EL).

import { h, mount } from '../lib/dom.js';
import { t, isSuperAdmin } from '../lib/state.js';

const SECTIONS = [
  ['signin', ['help.signin_1', 'help.signin_2', 'help.signin_3', 'help.signin_4']],
  ['sidebar', ['help.sidebar_1', 'help.sidebar_2', 'help.sidebar_3']],
  ['roles', ['help.roles_1', 'help.roles_2', 'help.roles_3', 'help.roles_4', 'help.roles_5']],
  ['supervisors', ['help.sup_1', 'help.sup_2']],
  ['admin', ['help.admin_1', 'help.admin_2', 'help.admin_3', 'help.admin_4'], true],
];

export default function help(root) {
  const toc = h('nav', { class: 'card pad mb-16', 'aria-label': t('help.contents') }, h('strong', null, t('help.contents')),
    h('ol', { class: 'small' }, SECTIONS.filter(([, , a]) => !a || isSuperAdmin()).map(([k]) => h('li', null, h('a', { href: '#help-' + k, onclick: (e) => { e.preventDefault(); document.getElementById('help-' + k)?.scrollIntoView({ behavior: 'smooth' }); } }, t('help.h_' + k))))));
  mount(root, h('div', { class: 'page', style: { maxWidth: '820px' } },
    h('div', { class: 'page-head' }, h('h1', null, t('page.help'))),
    h('p', { class: 'muted' }, t('help.lead')),
    toc,
    SECTIONS.filter(([, , a]) => !a || isSuperAdmin()).map(([k, paras]) => h('section', { class: 'mb-16', id: 'help-' + k },
      h('h2', { class: 'mb-8' }, t('help.h_' + k)), paras.map(p => h('p', null, t(p)))))));
}
