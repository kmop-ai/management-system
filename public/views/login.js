// Sign in with a magic link, and redeem the link.

import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t } from '../lib/state.js';
import { errorText } from '../lib/ui.js';

export default async function login(root, params, query) {
  // Before sign-in we do not know the person's language; follow the browser.
  if (!state.me) state.locale = (navigator.language || '').toLowerCase().startsWith('el') ? 'el' : 'en';
  if (params.mode === 'verify') return verify(root, query);

  const msg = h('div', { 'aria-live': 'polite' });
  const email = h('input', { class: 'input', id: 'login-email', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@kmop.org', style: { width: '100%' } });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%' } }, t('auth.send'));
  const form = h('form', { class: 'col gap-12', onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      const r = await api.post('/auth/request-link', { email: email.value.trim(), redirect: query.next && query.next.startsWith('#/') ? query.next : null });
      mount(msg, h('div', { class: 'banner info' }, local && !r.dev_link ? t('auth.local_no_email') : t('auth.sent')),
        r.dev_link ? h('p', { class: 'mt-8 small' }, t('auth.dev_link'), ': ', h('a', { href: r.dev_link.replace(/^https?:\/\/[^/]+/, '') }, t('common.open'))) : null);
    } catch (err) {
      mount(msg, h('div', { class: 'banner danger' }, errorText(err)));
    } finally { btn.disabled = false; }
  } },
    h('div', { class: 'field' }, h('label', { for: 'login-email' }, t('auth.email_label')), email),
    btn, msg);
  // A local installation sends no email: say so, instead of "check your inbox".
  let local = false;
  try { local = !!(await api.get('/health')).local_mode; } catch {}
  mount(root, h('div', { class: 'auth-wrap' }, h('main', { class: 'auth-card' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, 'K'),
    h('h1', { class: 'mb-8' }, t('auth.title')),
    h('p', { class: 'muted small mb-16' }, local ? t('auth.local_lead') : t('auth.lead')),
    form,
    h('p', { class: 'muted xs mt-16' }, 'KMOP ASSOCIATION · KMOP POLICY CENTER · KMOP EDUCATION HUB'))));
  document.title = t('auth.title');
  email.focus();
}

async function verify(root, query) {
  mount(root, h('div', { class: 'auth-wrap' }, h('main', { class: 'auth-card' }, h('div', { class: 'logo' }, 'K'), h('p', { 'aria-live': 'polite' }, t('auth.verifying')))));
  try {
    const r = await api.post('/auth/verify', { token: query.token || '' });
    const target = r.redirect && r.redirect.startsWith('#/') && !r.redirect.startsWith('#/auth') ? r.redirect : '#/my-tasks';
    // A full reload gives the shell a clean bootstrap for the new session.
    location.replace(location.pathname + target);
    location.reload();
  } catch (e) {
    mount(root, h('div', { class: 'auth-wrap' }, h('main', { class: 'auth-card' },
      h('div', { class: 'logo' }, 'K'),
      h('div', { class: 'banner danger mb-16' }, t('auth.invalid')),
      h('a', { class: 'btn primary', href: '#/login' }, t('auth.try_again')))));
  }
}
