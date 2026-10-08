#!/usr/bin/env node
// KMOP HQ as a real local installation — no cloud services at all.
//
//   npm run local:setup              first time: database, the three entities, you as administrator
//   npm run local                    start it (keeps running; Ctrl+C to stop)
//   npm run local:reset-password -- <email>   new temporary password (forgotten password)
//   npm run local:link -- <email>    print a one-time sign-in link for someone
//   npm run local:backup             copy everything (database, files, sessions) to backups/ (stop KMOP HQ first for a fully consistent copy)
//
// It runs on workerd — the same open-source runtime Cloudflare uses — on this
// computer. All data lives in ./local-data and never leaves the machine.
// Colleagues on the same network open http://<this computer's address>:8787.
// There is no email: people sign in with email + password. An administrator
// adds a person in the app and passes on the temporary password it shows;
// the person picks their own at first sign-in.

import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes, pbkdf2Sync, randomInt } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces, hostname, platform } from 'node:os';
import { createInterface } from 'node:readline/promises';

const DATA = 'local-data';
const PORT = process.env.PORT || '8787';
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

// Same format as src/lib/password.js (PBKDF2-SHA256, 100 000 iterations).
function setTemporaryPassword(userId) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const raw = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
  const pw = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('base64');
  sql(`INSERT INTO password_credentials (user_id, hash, salt, iterations, must_change) VALUES (${userId}, ${q(hash)}, ${q(salt.toString('base64'))}, 100000, 1)
       ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt, iterations = excluded.iterations, must_change = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');
       UPDATE users SET token_version = token_version + 1 WHERE id = ${userId}`);
  return pw;
}
const findUser = (email) => sql(`SELECT id, name, email FROM users WHERE email = ${q(String(email).toLowerCase())} AND deleted_at IS NULL AND active = 1`)[0];

function migrate() {
  mkdirSync(DATA, { recursive: true });
  execFileSync('node', ['scripts/check-migrations.mjs'], { stdio: 'inherit' });
  wrangler(['d1', 'migrations', 'apply', 'kmop-hq', '--local', '--persist-to', DATA], { quiet: true, input: 'y\n' });
}

function makeLink(email, hours = 72) {
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
  return { name: u.name, link: `${baseUrl()}/#/auth/verify?token=${token}` };
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
       INSERT INTO users (email, name, entity_id, locale) VALUES (${q(email)}, ${q(name)}, 1, ${q(lang)});
       INSERT INTO user_roles (user_id, role) SELECT id, 'super_admin' FROM users WHERE email = ${q(email)};
       INSERT INTO audit_log (action, object_type, object_label, summary) VALUES ('create', 'installation', 'KMOP HQ', ${q(`Local installation set up with ${name} as administrator`)})`);
  const pw = setTemporaryPassword(findUser(email).id);
  console.log(`\n  Done. Start KMOP HQ by double-clicking "Start KMOP HQ" in this folder (or: npm run local).\n\n  Sign in with\n      email:     ${email}\n      password:  ${pw}     (temporary — you choose your own at first sign-in)\n`);
}

function start() {
  if (!existsSync(DATA)) { console.error('\n  Not set up yet. Run:  npm run local:setup\n'); process.exit(1); }
  migrate(); // applies any new migrations after an update (git pull)
  // If no administrator has a password yet (installations set up before
  // passwords existed), give the first one a temporary password now.
  const admin = sql(`SELECT u.id, u.email, u.name FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'super_admin' AND r.revoked_at IS NULL
                     WHERE u.active = 1 AND u.deleted_at IS NULL AND u.id NOT IN (SELECT user_id FROM password_credentials) ORDER BY u.id LIMIT 1`)[0];
  const anyAdminWithPw = sql(`SELECT COUNT(*) AS n FROM password_credentials p JOIN user_roles r ON r.user_id = p.user_id AND r.role = 'super_admin' AND r.revoked_at IS NULL`)[0].n;
  let firstPw = null;
  if (admin && !anyAdminWithPw) firstPw = { email: admin.email, pw: setTemporaryPassword(admin.id) };
  const url = nameUrl() || baseUrl();
  // On a Mac, keep the computer awake while KMOP HQ runs (the screen may still sleep).
  const keepAwake = platform() === 'darwin' ? spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
  const dev = spawn('npx', ['wrangler', 'dev', '--ip', '0.0.0.0', '--port', PORT, '--persist-to', DATA, '--test-scheduled',
    '--var', 'DEV_MODE:0', '--var', 'LOCAL_MODE:1', '--var', `APP_URL:${url}`, '--var', 'AUTO_PROVISION:0'], { stdio: ['inherit', 'pipe', 'inherit'] });
  let announced = false;
  dev.stdout.on('data', (b) => {
    const s = b.toString();
    if (!announced && s.includes('Ready on')) {
      announced = true;
      console.log(`\n  ✅  KMOP HQ is running.\n\n     Address for everyone in the office:   ${url}\n     (also works: ${baseUrl()} , and on this computer http://localhost:${PORT})\n`);
      if (firstPw) console.log(`     Sign in as ${firstPw.email} with the temporary password  ${firstPw.pw}\n`);
      console.log(`     Add colleagues in the app: Administration → People → Add person.\n     It shows each person's temporary password to give them.\n\n     Keep this window open. Closing it stops KMOP HQ for everyone.\n`);
      if (platform() === 'darwin') spawn('open', [`http://localhost:${PORT}`], { stdio: 'ignore' });
    }
    if (/\b(ERROR|Error)\b/.test(s)) process.stdout.write(s);
  });
  // Hourly jobs (due-date notices, recurring tasks, retention) — the
  // local runtime does not fire cron triggers by itself.
  const tick = () => fetch(`http://localhost:${PORT}/__scheduled?cron=5+*+*+*+*`).catch(() => {});
  setTimeout(tick, 15000);
  setInterval(tick, 3600000);
  const stop = () => { dev.kill('SIGINT'); if (keepAwake) keepAwake.kill(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  dev.on('exit', (c) => process.exit(c ?? 0));
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
} else if (cmd === 'reset-password') {
  const u = findUser(process.argv[3] || '');
  if (!u) { makeLink(process.argv[3] || '?'); }
  const pw = setTemporaryPassword(u.id);
  console.log(`\n  New temporary password for ${u.name} (${u.email}):  ${pw}\n  They choose their own at next sign-in.\n`);
} else if (cmd === 'backup') backup();
else { console.error(`  Unknown command ${cmd}. Use setup, start, link or backup.`); process.exit(1); }
