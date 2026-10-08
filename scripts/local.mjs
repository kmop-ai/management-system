#!/usr/bin/env node
// KMOP HQ as a real local installation — no cloud services at all.
//
//   npm run local:setup              first time: database, the three entities, you as administrator
//   npm run local                    start it (keeps running; Ctrl+C to stop)
//   npm run local:link -- <email>    print a one-time sign-in link for someone
//   npm run local:backup             copy everything (database, files, sessions) to backups/ (stop KMOP HQ first for a fully consistent copy)
//
// It runs on workerd — the same open-source runtime Cloudflare uses — on this
// computer. All data lives in ./local-data and never leaves the machine.
// Colleagues on the same network open http://<this computer's address>:8787.
// Sign-in has no passwords: Google, or a personal link emailed from the
// organisation mailbox (connected in Team and Access → Integrations). Until
// the mailbox is connected, the window prints a sign-in link for the
// administrator, and `npm run local:link -- <email>` prints one for anyone.

import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, pbkdf2Sync, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { networkInterfaces, hostname, platform, arch } from 'node:os';
import { createInterface } from 'node:readline/promises';

const DATA = 'local-data';
const PORT = process.env.PORT || '8787';        // what people connect to (Caddy)
const APP_PORT = String(Number(PORT) + 1);        // the app itself, reachable only from this computer
const CADDY_VERSION = '2.8.4';
const CONFIG = `${DATA}/config.json`;
const readConfig = () => { try { return JSON.parse(readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const writeConfig = (c) => writeFileSync(CONFIG, JSON.stringify(c, null, 2));
const cmd = process.argv[2] || 'start';
const wrangler = (args, opts = {}) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'inherit', ...opts });
const sql = (command) => JSON.parse(wrangler(['d1', 'execute', 'kmop-hq', '--local', '--persist-to', DATA, '--json', '--command', command], { quiet: true }))[0].results;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  return 'localhost';
}
const baseUrl = () => `http://${lanAddress()}:${PORT}`;
// The Mac's network name (MacBook-Pro-Danai.local) stays the same when the
// Wi-Fi hands out a new IP address, so it is the address to give colleagues.
const nameUrl = () => { const n = hostname().replace(/\.local$/, ''); return n && n !== 'localhost' ? `http://${n}.local:${PORT}` : null; };

const findUser = (email) => sql(`SELECT id, name, email FROM users WHERE email = ${q(String(email).toLowerCase())} AND deleted_at IS NULL AND active = 1`)[0];

function migrate() {
  mkdirSync(DATA, { recursive: true });
  execFileSync('node', ['scripts/check-migrations.mjs'], { stdio: 'inherit' });
  wrangler(['d1', 'migrations', 'apply', 'kmop-hq', '--local', '--persist-to', DATA], { quiet: true, input: 'y\n' });
}

// ---- Caddy: the front door ----------------------------------------------
//
// The app (workerd) only listens on 127.0.0.1. Everyone — office network and,
// with a public address, the internet — goes through Caddy, which:
//   * blocks the runtime's built-in development endpoints (/cdn-cgi/…, the
//     local database explorer, /__scheduled), which must never be reachable;
//   * on a public address, gets and renews a Let's Encrypt certificate by
//     itself and serves HTTPS only.
function caddyBinary() {
  for (const p of ['bin/caddy', '/opt/homebrew/bin/caddy', '/usr/local/bin/caddy', '/usr/bin/caddy']) if (existsSync(p)) return p;
  // Download the official release once, into ./bin (about 15 MB).
  const os = platform() === 'darwin' ? 'mac' : 'linux';
  const a = arch() === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_${os}_${a}.tar.gz`;
  console.log(`  Downloading Caddy ${CADDY_VERSION} (one time)…`);
  mkdirSync('bin', { recursive: true });
  execFileSync('bash', ['-c', `curl -fsSL "${url}" | tar -xz -C bin caddy`], { stdio: 'inherit' });
  chmodSync('bin/caddy', 0o755);
  return 'bin/caddy';
}

function caddyfile(cfg) {
  const protect = `\t@internal path /cdn-cgi/* /__scheduled*\n\trespond @internal 404\n\tencode gzip\n\treverse_proxy 127.0.0.1:${APP_PORT}\n`;
  let f = `{\n\tadmin off\n${cfg.public_host ? (cfg.admin_email ? `\temail ${cfg.admin_email}\n` : '') : '\tauto_https off\n'}}\n\n`;
  f += `# Office network\nhttp://:${PORT} {\n${protect}}\n`;
  if (cfg.public_host) f += `\n# Internet (HTTPS, certificate from Let's Encrypt, renewed automatically)\n${cfg.public_host} {\n${protect}\theader Strict-Transport-Security "max-age=31536000"\n}\n`;
  writeFileSync(`${DATA}/Caddyfile`, f);
  return `${DATA}/Caddyfile`;
}

function makeLink(email, hours = 72, base = null) {
  const u = sql(`SELECT id, name FROM users WHERE email = ${q(email.toLowerCase())} AND deleted_at IS NULL AND active = 1`)[0];
  if (!u) {
    const all = sql(`SELECT email, name FROM users WHERE deleted_at IS NULL AND active = 1 ORDER BY name LIMIT 50`);
    console.error(`\n  No active person with the email ${email}. Add them in the app first (People → Add person).`);
    if (all.length) console.error(`\n  People who can sign in:\n${all.map(x => `    ${x.email}   (${x.name})`).join('\n')}`);
    console.error('');
    process.exit(1);
  }
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const exp = new Date(Date.now() + hours * 3600000).toISOString();
  sql(`INSERT INTO magic_links (token_hash, user_id, expires_at) VALUES (${q(hash)}, ${u.id}, ${q(exp)});
       INSERT INTO audit_log (action, object_type, object_id, object_label, summary) VALUES ('grant', 'user', ${u.id}, ${q(u.name)}, ${q(`A one-time sign-in link for ${u.name} was created on the server console, valid ${hours} hours`)})`);
  return { name: u.name, link: `${base || nameUrl() || baseUrl()}/#/auth/verify?token=${token}` };
}

async function setup() {
  if (!existsSync('node_modules')) execFileSync('npm', ['install'], { stdio: 'inherit' });
  migrate();
  const people = sql(`SELECT COUNT(*) AS n FROM users`)[0].n;
  if (people > 0) {
    console.log(`\n  Already set up (${people} people in ${DATA}/). Start it with:  npm run local\n  Need a sign-in link?             npm run local:link -- you@example.org\n`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => { process.stdout.write(prompt); const r = await lines.next(); return r.done ? '' : r.value; };
  console.log('\n  KMOP HQ — first-time setup. You will be the administrator.\n');
  const name = (await ask('  Your full name: ')).trim();
  const email = (await ask('  Your email:     ')).trim().toLowerCase();
  const lang = ((await ask('  Interface language, en or el [en]: ')).trim() || 'en').toLowerCase() === 'el' ? 'el' : 'en';
  rl.close();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('  A name and a valid email are needed.'); process.exit(1); }
  // The three entities. Edit their details later in Administration → Entities.
  sql(`INSERT INTO entities (code, name, country, city, timezone, color) VALUES
         ('ASSOC', 'KMOP ASSOCIATION', 'GR', 'Athens', 'Europe/Athens', '#2563eb'),
         ('POLICY', 'KMOP POLICY CENTER', 'BE', 'Brussels', 'Europe/Brussels', '#7c3aed'),
         ('EDU', 'KMOP EDUCATION HUB', 'GR', 'Athens', 'Europe/Athens', '#059669');
       INSERT INTO users (email, name, entity_id, locale, role) VALUES (${q(email)}, ${q(name)}, 1, ${q(lang)}, 'super_admin');
       INSERT INTO user_roles (user_id, role) SELECT id, 'super_admin' FROM users WHERE email = ${q(email)};
       INSERT INTO audit_log (action, object_type, object_label, summary) VALUES ('create', 'installation', 'KMOP HQ', ${q(`Local installation set up with ${name} as administrator`)})`);
  // Configuration: the super admin(s) and the allowed email domain.
  writeConfig({ ...readConfig(), super_admins: [email], allowed_domains: [email.split('@')[1]] });
  console.log(`\n  Done. Start KMOP HQ by double-clicking "Start KMOP HQ" in this folder (or: npm run local).\n  The window will show your personal sign-in link.\n`);
}

function start() {
  if (!existsSync(DATA)) { console.error('\n  Not set up yet. Run:  npm run local:setup\n'); process.exit(1); }
  migrate(); // applies any new migrations after an update (git pull)
  const cfg = readConfig();
  // Until the organisation mailbox is connected, sign-in links cannot be
  // emailed: print one for the (first) super admin, for use on this laptop.
  const mailbox = sql(`SELECT status FROM integrations WHERE key = 'gmail'`)[0];
  const admin = sql(`SELECT email FROM users WHERE role = 'super_admin' AND active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1`)[0];
  let firstLink = null;
  if (admin && mailbox?.status !== 'connected') firstLink = makeLink(admin.email, 72, `http://localhost:${PORT}`);
  const url = cfg.public_host ? `https://${cfg.public_host}` : (nameUrl() || baseUrl());
  const caddyBin = caddyBinary();
  const caddy = spawn(caddyBin, ['run', '--config', caddyfile(cfg), '--adapter', 'caddyfile'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, XDG_DATA_HOME: `${process.cwd()}/${DATA}/caddy`, XDG_CONFIG_HOME: `${process.cwd()}/${DATA}/caddy` },
  });
  const caddyLog = (b) => {
    for (const line of b.toString().split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (/certificate obtained successfully/.test(j.msg)) console.log(`  [https] ✅ certificate obtained — https://${cfg.public_host} works from anywhere`);
        else if (j.level === 'error' && /could not get certificate|obtaining certificate/.test(j.msg + (j.error || ''))) console.log(`  [https] ⚠ no certificate yet for ${cfg.public_host}: check the DNS record and that the router forwards ports 80 and 443 to this computer (docs/OFFICE-SERVER.md). Retrying automatically.`);
        else if (j.level === 'error') console.log(`  [https] ${j.msg}${j.error ? ': ' + j.error : ''}`);
      }
      catch { if (/error/i.test(line)) console.log('  [https] ' + line); }
    }
  };
  caddy.stdout.on('data', caddyLog); caddy.stderr.on('data', caddyLog);
  caddy.on('exit', (c) => { if (c) console.log(`\n  The front door (Caddy) stopped with code ${c}. Is another program using port ${PORT}${cfg.public_host ? ', 80 or 443' : ''}?\n`); });
  // On a Mac, keep the computer awake while KMOP HQ runs (the screen may still sleep).
  const keepAwake = platform() === 'darwin' ? spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
  const dev = spawn('npx', ['wrangler', 'dev', '--ip', '127.0.0.1', '--port', APP_PORT, '--persist-to', DATA, '--test-scheduled',
    '--var', 'DEV_MODE:0', '--var', 'LOCAL_MODE:1', '--var', `APP_URL:${url}`, '--var', 'AUTO_PROVISION:1',
    '--var', `SUPER_ADMINS:${(cfg.super_admins || []).join(',')}`, '--var', `ALLOWED_EMAIL_DOMAINS:${(cfg.allowed_domains || ['kmop.org']).join(',')}`], { stdio: ['inherit', 'pipe', 'inherit'] });
  let announced = false;
  dev.stdout.on('data', (b) => {
    const s = b.toString();
    if (!announced && s.includes('Ready on')) {
      announced = true;
      console.log(`\n  ✅  KMOP HQ is running.\n\n     ${cfg.public_host ? 'Address for everyone, from anywhere:' : 'Address for everyone in the office:'}   ${url}\n     ${cfg.public_host ? `(in the office also: ${nameUrl() || baseUrl()})` : `(also: ${baseUrl()} — only on the office network. For access from anywhere: npm run local:public -- hq.kmop.org)`}\n`);
      if (firstLink) console.log(`     Your sign-in link (for you, on this laptop; works once):\n       ${firstLink.link}\n\n     To email links to colleagues, connect the mailbox: Team and Access → Integrations.\n`);
      console.log(`     Colleagues with a KMOP address sign in on their own (Google or emailed link).\n     Roles and modules: Team and Access.\n\n     Keep this window open. Closing it stops KMOP HQ for everyone.\n`);
      if (platform() === 'darwin') spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore' });
    }
    if (/\b(ERROR|Error)\b/.test(s)) process.stdout.write(s);
  });
  // Hourly jobs (due-date notices, recurring tasks, retention) — the
  // local runtime does not fire cron triggers by itself.
  const tick = () => fetch(`http://127.0.0.1:${APP_PORT}/__scheduled?cron=5+*+*+*+*`).catch(() => {});
  setTimeout(tick, 15000);
  setInterval(tick, 3600000);
  const stop = () => { dev.kill('SIGINT'); caddy.kill(); if (keepAwake) keepAwake.kill(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  dev.on('exit', (c) => { caddy.kill(); process.exit(c ?? 0); });
}

function backup() {
  if (!existsSync(DATA)) { console.error('  Nothing to back up yet.'); process.exit(1); }
  mkdirSync('backups', { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  execFileSync('tar', ['-czf', `backups/kmop-hq-${stamp}.tar.gz`, DATA]);
  console.log(`\n  Backed up everything (database, uploaded files, sessions) to backups/kmop-hq-${stamp}.tar.gz\n\n  To restore: stop KMOP HQ, delete ${DATA}/, run  tar -xzf backups/kmop-hq-${stamp}.tar.gz , start again.\n  Copy backups/ somewhere safe (an external disk) regularly.\n`);
}

if (cmd === 'setup') await setup();
else if (cmd === 'start') start();
else if (cmd === 'link') {
  const email = (process.argv[3] || '').trim();
  if (!email) { console.error('  Usage: npm run local:link -- someone@example.org'); makeLink('?'); }
  const { name, link } = makeLink(email);
  console.log(`\n  One-time sign-in link for ${name} (valid 72 hours, works once):\n\n      ${link}\n\n  Send it to them directly. Anyone with this link can sign in as ${name}.\n`);
} else if (cmd === 'public') {
  const host = (process.argv[3] || '').trim().toLowerCase();
  const cfg = readConfig();
  if (!host) { console.log(`\n  Public address: ${cfg.public_host || '(none — office network only)'}\n  Set one:  npm run local:public -- hq.kmop.org     Remove:  npm run local:public -- off\n`); }
  else if (host === 'off') { delete cfg.public_host; writeConfig(cfg); console.log('\n  Public address removed. Restart KMOP HQ.\n'); }
  else if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) { console.error('  That is not a domain name, e.g. hq.kmop.org'); process.exit(1); }
  else {
    const admin = sql(`SELECT u.email FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'super_admin' AND r.revoked_at IS NULL ORDER BY u.id LIMIT 1`)[0];
    cfg.public_host = host; if (admin) cfg.admin_email = admin.email; writeConfig(cfg);
    console.log(`\n  Public address set to https://${host}\n\n  Before restarting KMOP HQ, your IT person or provider must have done the steps in docs/OFFICE-SERVER.md:\n    1. a DNS record  ${host}  →  the office's static public IP\n    2. router: forward TCP ports 80 and 443  →  this computer (${lanAddress()})\n  Then restart KMOP HQ. The certificate is obtained automatically on first start.\n`);
  }
} else if (cmd === 'backup') backup();
else { console.error(`  Unknown command ${cmd}. Use setup, start, link or backup.`); process.exit(1); }
