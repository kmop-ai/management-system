// KMOP HQ — Worker entry point.
//
// /api/* is routed here; everything else is the static SPA in public/.
// Each request gets a context (ctx) carrying env, the signed-in user, their
// access, and a queue of audit/activity/notification statements that are
// written in one D1 batch after the handler succeeds.

import routes from './src/routes/index.js';
import { HttpError, errorResponse, json, unauthorized } from './src/lib/http.js';
import { loadSession } from './src/lib/auth.js';
import { loadAccess } from './src/lib/rbac.js';
import { auditStmt, activityStmt } from './src/lib/audit.js';
import { notifyStmts, emailImmediate } from './src/lib/notify.js';
import { sendPending } from './src/lib/mail.js';
import { stmt, nowIso } from './src/lib/db.js';
import { scheduled } from './src/cron.js';

const compiled = routes.map(([method, path, handler, opts = {}]) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { method, path, handler, opts, re, keys };
});

export const ROUTES = compiled.map(r => ({ method: r.method, path: r.path, auth: r.opts.auth !== false }));

function match(method, pathname) {
  let pathMatched = false;
  for (const r of compiled) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return { route: null, pathMatched };
}

function makeContext(req, env, ectx, url) {
  const ctx = {
    env, req, url, ectx,
    requestId: crypto.randomUUID().slice(0, 8),
    ip: req.headers.get('cf-connecting-ip') || null,
    user: null,
    access: null,
    pending: [],
    hasNewNotifications: false,
    audit(e) { ctx.pending.push(auditStmt(ctx, e)); },
    activity(e) { ctx.pending.push(activityStmt(ctx, e)); },
    notify(userIds, n) { ctx.pending.push(...notifyStmts(ctx, userIds, n)); },
    // Every write under a project marks it as active; Phase 5's "no recent
    // activity" reads this column instead of scanning the activity table.
    touchProject(projectId) {
      if (projectId) ctx.pending.push(stmt(env.DB, `UPDATE projects SET last_activity_at = ? WHERE id = ?`, nowIso(), projectId));
    },
  };
  return ctx;
}

export default {
  async fetch(req, env, ectx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    const started = Date.now();
    const ctx = makeContext(req, env, ectx, url);
    try {
      // Route inventory for scripts/smoke.mjs, which fails if any route goes untested.
      if (url.pathname === '/api/_routes' && env.DEV_MODE === '1') return json({ data: ROUTES });
      const { route, params, pathMatched } = match(req.method, url.pathname);
      if (!route) {
        throw pathMatched
          ? new HttpError(405, 'method_not_allowed', `${req.method} is not supported here`)
          : new HttpError(404, 'not_found', `No route for ${url.pathname}`);
      }
      if (route.opts.dev && env.DEV_MODE !== '1') throw new HttpError(404, 'not_found', `No route for ${url.pathname}`);

      // Cross-site request forgery: the session cookie is SameSite=Lax, and
      // on top of that every state-changing request must come from our own
      // origin when the browser says where it came from.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.get('origin');
        if (origin && origin !== url.origin) throw new HttpError(403, 'bad_origin', 'Cross-origin request refused');
      }

      ctx.user = await loadSession(env, req);
      if (route.opts.auth !== false) {
        if (!ctx.user) throw unauthorized();
        ctx.access = await loadAccess(env.DB, ctx.user);
      }

      const res = await route.handler(ctx, params);
      if (ctx.pending.length) await env.DB.batch(ctx.pending);
      if (ctx.hasNewNotifications) {
        ectx.waitUntil(emailImmediate(env, url.origin).then(() => sendPending(env, 20)).catch(e => console.error('immediate email', e)));
      }
      const headers = new Headers(res.headers);
      headers.set('x-request-id', ctx.requestId);
      headers.set('server-timing', `app;dur=${Date.now() - started}`);
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      return errorResponse(err, ctx.requestId);
    }
  },

  scheduled(event, env, ectx) {
    ectx.waitUntil(scheduled(event, env));
  },
};
