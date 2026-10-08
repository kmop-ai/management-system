// Sign in: Google Workspace, or a personal link by email. No passwords.

import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t } from '../lib/state.js';
import { errorText } from '../lib/ui.js';

export default async function login(root, params, query) {
  // Before sign-in we do not know the person's language; follow the browser.
  if (!state.me) state.locale = (navigator.language || '').toLowerCase().startsWith('el') ? 'el' : 'en';
  if (params.mode === 'verify') return verify(root, query);

  let methods = { link: true, google: false };
  try { methods = await api.get('/auth/methods'); } catch {}
  const next = query.next && query.next.startsWith('#/') && !query.next.startsWith('#/auth') && !query.next.startsWith('#/login') ? query.next : '';

  const msg = h('div', { 'aria-live': 'polite' });
  if (query.error === 'google_denied') mount(msg, h('div', { class: 'banner danger' }, t('auth.google_denied')));
  if (query.error === 'google_unavailable') mount(msg, h('div', { class: 'banner warn' }, t('auth.google_unavailable')));

  const email = h('input', { class: 'input', id: 'login-email', type: 'email', required: true, autocomplete: 'email', placeholder: 'name@kmop.org', style: { width: '100%' } });
  const btn = h('button', { class: 'btn', type: 'submit', style: { width: '100%' } }, t('auth.send'));
  const form = h('form', { class: 'col gap-12', onsubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      const r = await api.post('/auth/request-link', { email: email.value.trim(), redirect: next || null });
      mount(msg, h('div', { class: 'banner info' }, t('auth.sent')),
        r.dev_link ? h('p', { class: 'mt-8 small' }, t('auth.dev_link'), ': ', h('a', { href: r.dev_link.replace(/^https?:\/\/[^/]+/, '') }, t('common.open'))) : null);
    } catch (err) {
      mount(msg, h('div', { class: 'banner danger' }, errorText(err)));
    } finally { btn.disabled = false; }
  } },
    h('div', { class: 'field' }, h('label', { for: 'login-email' }, t('auth.email_label')), email), btn);

  const google = methods.google
    ? h('a', { class: 'btn primary google-btn', href: `/api/auth/google/start${next ? '?next=' + encodeURIComponent(next) : ''}`, style: { width: '100%', height: '38px' } },
        h('span', { class: 'g-logo', 'aria-hidden': 'true', html: '<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.3-.4-3.5z"/></svg>' }),
        t('auth.google'))
    : null;

  mount(root, h('div', { class: 'auth-wrap' }, h('main', { class: 'auth-card' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, 'K'),
    h('h1', { class: 'mb-8' }, t('auth.title')),
    h('p', { class: 'muted small mb-16' }, google ? t('auth.lead_both') : t('auth.lead')),
    google, google ? h('div', { class: 'or-line' }, h('span', null, t('auth.or'))) : null,
    form, msg,
    h('p', { class: 'muted xs mt-16' }, t('auth.no_passwords')))));
  document.title = t('auth.title');
  if (!google) email.focus();
}

async function verify(root, query) {
  mount(root, h('div', { class: 'auth-wrap' }, h('main', { class: 'auth-card' }, h('div', { class: 'logo' }, 'K'), h('p', { 'aria-live': 'polite' }, t('auth.verifying')))));
  try {
    const r = await api.post('/auth/verify', { token: query.token || '' });
    const target = r.redirect && r.redirect.startsWith('#/') && !r.redirect.startsWith('#/auth') ? r.redirect : '#/';
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
