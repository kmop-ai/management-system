// A stand-in for Google's OAuth and Gmail endpoints, for the smoke test
// only. The Worker is pointed at it with GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL /
// GMAIL_API_BASE (see scripts/test-local.sh), so the full sign-in and
// mailbox flows run without a real Google account.
//
//   GET  /authorize?redirect_uri&state&client_id&test_email=…   → 302 back with a code
//   POST /token                                                 → tokens + an (unsigned) id_token
//   POST /gmail/v1/users/me/messages/send                       → records the message
//   GET  /_messages                                             → what was "sent", decoded

import { createServer } from 'node:http';

const b64url = (s) => Buffer.from(s).toString('base64url');

export function startFakeGoogle(port = 8798) {
  const messages = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let body = '';
    for await (const c of req) body += c;
    if (url.pathname === '/authorize') {
      const code = b64url(JSON.stringify({ email: url.searchParams.get('test_email') || 'someone@kmop.org', client: url.searchParams.get('client_id') }));
      res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(url.searchParams.get('state'))}` });
      return res.end();
    }
    if (url.pathname === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'refresh_token') return json(res, { access_token: 'at-' + Date.now(), expires_in: 3600 });
      let c;
      try { c = JSON.parse(Buffer.from(f.get('code') || '', 'base64url').toString()); } catch { return json(res, { error: 'invalid_grant' }, 400); }
      const claims = { iss: 'https://accounts.google.com', aud: f.get('client_id'), sub: 'sub-' + c.email, email: c.email, email_verified: true,
        name: c.email.split('@')[0].replace(/\./g, ' '), exp: Math.floor(Date.now() / 1000) + 3600 };
      return json(res, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'openid email',
        id_token: `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.` });
    }
    if (url.pathname === '/gmail/v1/users/me/messages/send') {
      const raw = Buffer.from(JSON.parse(body).raw, 'base64url').toString();
      const [head, b] = raw.split('\r\n\r\n');
      messages.push({ to: /^To: (.*)$/m.exec(head)?.[1], text: Buffer.from(b.replace(/\r\n/g, ''), 'base64').toString() });
      return json(res, { id: 'msg-' + messages.length });
    }
    if (url.pathname === '/_messages') return json(res, messages);
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, messages, close: () => server.close() })));
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
