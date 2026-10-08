// Choose / change my password (installations with password sign-in).
// Shown full-screen right after a first sign-in with a temporary password,
// and as a card on My settings.

import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t } from '../lib/state.js';
import { errorText, toast } from '../lib/ui.js';

export function passwordForm({ forced = false, onDone } = {}) {
  const msg = h('div', { 'aria-live': 'polite' });
  const field = (id, label, attrs = {}) => h('div', { class: 'field' }, h('label', { for: id }, label),
    h('input', { class: 'input', id, type: 'password', required: true, style: { width: '100%' }, ...attrs }));
  const cur = forced ? null : field('pw-current', t('pw.current'), { autocomplete: 'current-password' });
  const nw = field('pw-new', t('pw.new'), { autocomplete: 'new-password', minlength: 8 });
  const again = field('pw-again', t('pw.again'), { autocomplete: 'new-password', minlength: 8 });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, forced ? t('pw.choose_btn') : t('pw.change_btn'));
  const form = h('form', { class: 'col gap-12', onsubmit: async (e) => {
    e.preventDefault();
    const p1 = nw.querySelector('input').value, p2 = again.querySelector('input').value;
    if (p1 !== p2) { mount(msg, h('div', { class: 'banner danger' }, t('pw.mismatch'))); return; }
    btn.disabled = true;
    try {
      await api.post('/me/password', { password: p1, current: cur ? cur.querySelector('input').value : undefined });
      toast(t('pw.changed'));
      form.reset(); mount(msg);
      if (onDone) onDone();
    } catch (err) { mount(msg, h('div', { class: 'banner danger' }, errorText(err))); }
    finally { btn.disabled = false; }
  } }, cur, nw, again, h('p', { class: 'muted xs' }, t('pw.rule')), btn, msg);
  return form;
}

// Full-screen: first sign-in with a temporary password.
export function forcedPasswordScreen(root) {
  mount(root, h('div', { class: 'auth-wrap' }, h('main', { class: 'auth-card' },
    h('div', { class: 'logo', 'aria-hidden': 'true' }, 'K'),
    h('h1', { class: 'mb-8' }, t('pw.welcome', { name: state.me.name })),
    h('p', { class: 'muted small mb-16' }, t('pw.choose_lead')),
    passwordForm({ forced: true, onDone: () => location.reload() }))));
  document.title = t('pw.choose_btn');
  root.querySelector('input')?.focus();
}
