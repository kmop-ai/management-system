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
// There is no email: people sign in with links you give them (here, or from
// their page in the app: People → person → Create sign-in link).

import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
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

function migrate() {
  mkdirSync(DATA, { recursive: true });
  execFileSync('node', ['scripts/check-migrations.mjs'], { stdio: 'inherit' });
  wrangler(['d1', 'migrations', 'apply', 'kmop-hq', '--local', '--persist-to', DATA], { quiet: true, input: 'y\n' });
}

function makeLink(email, hours = 72) {
  const u = sql(`SELECT id, name FROM users WHERE email = ${q(email.toLowerCase())} AND deleted_at IS NULL AND active = 1`)[0];
  if (!u) { console.error(`\n  No active person with the email ${email}. Add them in the app first (People → Add person).\n`); process.exit(1); }
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
  const { link } = makeLink(email);
  console.log(`\n  Done. Start KMOP HQ with:\n\n      npm run local\n\n  then open this link (once) to sign in as ${name}:\n\n      ${link}\n`);
}

function start() {
  if (!existsSync(DATA)) { console.error('\n  Not set up yet. Run:  npm run local:setup\n'); process.exit(1); }
  migrate(); // applies any new migrations after an update (git pull)
  const url = baseUrl();
  const dev = spawn('npx', ['wrangler', 'dev', '--ip', '0.0.0.0', '--port', PORT, '--persist-to', DATA, '--test-scheduled',
    '--var', 'DEV_MODE:0', '--var', 'LOCAL_MODE:1', '--var', `APP_URL:${url}`, '--var', 'AUTO_PROVISION:0'], { stdio: ['inherit', 'pipe', 'inherit'] });
  let announced = false;
  dev.stdout.on('data', (b) => {
    const s = b.toString();
    if (!announced && s.includes('Ready on')) {
      announced = true;
      console.log(`\n  KMOP HQ is running.\n\n    On this computer:        http://localhost:${PORT}\n    For colleagues (same network): ${url}\n\n  Sign-in links:  npm run local:link -- someone@example.org   (or People → person → Create sign-in link)\n  Keep this window open. Ctrl+C stops it. Data is in ./${DATA}/\n`);
    }
    if (/\b(ERROR|Error)\b/.test(s)) process.stdout.write(s);
  });
  // Hourly jobs (due-date notices, recurring tasks, retention) — the
  // local runtime does not fire cron triggers by itself.
  const tick = () => fetch(`http://localhost:${PORT}/__scheduled?cron=5+*+*+*+*`).catch(() => {});
  setTimeout(tick, 15000);
  setInterval(tick, 3600000);
  const stop = () => { dev.kill('SIGINT'); process.exit(0); };
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
  const email = process.argv[3];
  if (!email) { console.error('  Usage: npm run local:link -- someone@example.org'); process.exit(1); }
  const { name, link } = makeLink(email);
  console.log(`\n  One-time sign-in link for ${name} (valid 72 hours, works once):\n\n      ${link}\n\n  Send it to them directly. Anyone with this link can sign in as ${name}.\n`);
} else if (cmd === 'backup') backup();
else { console.error(`  Unknown command ${cmd}. Use setup, start, link or backup.`); process.exit(1); }
