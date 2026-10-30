/**
 * Accounts from the server's command line, for what cannot wait for Settings:
 * the first real users, the admin's own address, and a way in when e-mail is
 * down.
 *
 *   npm run users -- list
 *
 *   npm run users -- add --role partner --company Primis \
 *     "Omer Peleg <omerp@primis.tech>" "Gabriel Neumann <gabrieln@primis.tech>"
 *       Creates the ones that are missing. An account that already exists -
 *       same address, or same username or name - is completed (address filled
 *       in, re-enabled) instead of duplicated. Add --dry-run to only report.
 *
 *   npm run users -- set-email admin you@example.com
 *       The account by username, address or name.
 *
 *   npm run users -- login-link admin
 *       Prints a sign-in link and code (one use, one hour) without sending
 *       anything. For the admin when mail is not working yet. Whoever can run
 *       this already has the server, so it opens nothing new.
 */
import '../server/lib/env.js';

const { db } = await import('../server/lib/db.js');
const { issueLoginToken, signInLink, TOKEN_MINUTES } = await import('../server/lib/login.js');
const { usernameFor } = await import('../server/lib/auth.js');

const [command, ...rest] = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg === '--dry-run') flags.set('dry-run', true);
  else if (arg.startsWith('--')) flags.set(arg.slice(2), rest[(i += 1)] ?? '');
  else positional.push(arg);
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ROLES = ['admin', 'dev', 'partner'];

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** "Omer Peleg <omerp@primis.tech>", "Omer Peleg - omerp@primis.tech", or a bare address. */
function parsePerson(text) {
  const address = text.match(/[^\s<>,;]+@[^\s<>,;]+/)?.[0]?.toLowerCase();
  if (!address || !EMAIL.test(address)) return null;
  const name = text
    .replace(address, '')
    .replace(/[<>,;]/g, ' ')
    .replace(/\s+-\s*$|^\s*-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { email: address, name: name || address.split('@')[0] };
}

/** By address, then username, then name - whatever the person typing remembers. */
function findAccount(handle) {
  const key = String(handle).trim().toLowerCase();
  return (
    db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(key) ??
    db.prepare('SELECT * FROM users WHERE username = ?').get(key) ??
    db.prepare('SELECT * FROM users WHERE lower(name) = ?').get(key)
  );
}

function list() {
  const people = db.prepare('SELECT username, email, name, role, company, active, last_login_at FROM users ORDER BY company, name').all();
  console.log('');
  for (const p of people) {
    const placeholder = /\.test$/.test(p.email ?? '') || !p.email ? '  <- no real address, cannot sign in' : '';
    console.log(
      `  ${p.username.padEnd(14)} ${(p.email ?? '-').padEnd(30)} ${p.name.padEnd(18)} ${(p.company || '-').padEnd(10)} ` +
        `${p.role.padEnd(8)} ${p.active ? '' : '(disabled) '}${p.last_login_at ? `last in ${p.last_login_at}` : 'never signed in'}${placeholder}`
    );
  }
  console.log('');
}

function add() {
  const role = flags.get('role') ?? 'partner';
  const company = flags.get('company') ?? '';
  const dryRun = flags.has('dry-run');
  if (!ROLES.includes(role)) fail(`--role is one of ${ROLES.join(', ')}`);
  if (positional.length === 0) fail('Name the people: npm run users -- add --role partner --company Primis "Name <mail@example.com>"');

  const people = positional.map((text) => ({ text, person: parsePerson(text) }));
  const broken = people.filter((p) => !p.person);
  if (broken.length) fail(`No e-mail address in: ${broken.map((p) => `"${p.text}"`).join(', ')}`);

  const created = [];
  const completed = [];
  const unchanged = [];
  db.exec('BEGIN');
  try {
    for (const { person } of people) {
      /*
       * The address first. Then the username the address would give and the
       * name: an account made by hand before e-mail sign-in - "omery", no
       * address - is the same person, not a second one.
       */
      const existing =
        db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(person.email) ??
        db.prepare("SELECT * FROM users WHERE username = ? AND (email IS NULL OR email = '' OR email LIKE '%.test')").get(person.email.split('@')[0]) ??
        db.prepare("SELECT * FROM users WHERE lower(name) = lower(?) AND (email IS NULL OR email = '' OR email LIKE '%.test')").get(person.name);

      if (!existing) {
        if (!dryRun) {
          db.prepare(
            `INSERT INTO users (username, email, name, password_hash, role, company, inbox_seen_message_id)
             VALUES (?, ?, ?, '', ?, ?, (SELECT COALESCE(MAX(id), 0) FROM site_messages))`
          ).run(usernameFor(person.email), person.email, person.name, role, company);
        }
        created.push(person);
        continue;
      }

      const changes = [];
      if (String(existing.email ?? '').toLowerCase() !== person.email) changes.push(['email', person.email]);
      if (!existing.active) changes.push(['active', 1]);
      if (!existing.company && company) changes.push(['company', company]);
      if (changes.length === 0) {
        unchanged.push({ ...person, username: existing.username });
        continue;
      }
      if (!dryRun) {
        db.prepare(`UPDATE users SET ${changes.map(([f]) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...changes.map(([, v]) => v), existing.id);
      }
      completed.push({ ...person, username: existing.username, what: changes.map(([f]) => f).join(', ') });
    }
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const prefix = dryRun ? '(dry run) would have ' : '';
  for (const p of created) console.log(`  ${prefix}created     ${p.email.padEnd(28)} ${p.name} (${role}${company ? `, ${company}` : ''})`);
  for (const p of completed) console.log(`  ${prefix}updated     ${p.email.padEnd(28)} ${p.name} - existing account "${p.username}": ${p.what}`);
  for (const p of unchanged) console.log(`  already there ${p.email.padEnd(28)} ${p.name} ("${p.username}")`);
  console.log(`\n${created.length} created, ${completed.length} updated, ${unchanged.length} unchanged${dryRun ? ' - nothing written' : ''}.`);
  if (!dryRun && created.length + completed.length) console.log('They sign in by entering their e-mail address on the sign-in page.');
}

function setEmail() {
  const [handle, address] = positional;
  if (!handle || !address) fail('npm run users -- set-email <username|e-mail|name> <new e-mail>');
  const next = address.trim().toLowerCase();
  if (!EMAIL.test(next)) fail(`"${address}" is not an e-mail address`);
  const account = findAccount(handle);
  if (!account) fail(`No account "${handle}". See: npm run users -- list`);
  const clash = db.prepare('SELECT username FROM users WHERE lower(email) = ? AND id != ?').get(next, account.id);
  if (clash) fail(`${next} already belongs to "${clash.username}"`);

  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(next, account.id);
  // Same rule as in Settings: a changed address ends the sessions and open e-mails.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(account.id);
  db.prepare('DELETE FROM login_tokens WHERE user_id = ?').run(account.id);
  console.log(`"${account.username}" (${account.name}) now signs in as ${next}.`);
}

function loginLink() {
  const [handle] = positional;
  if (!handle) fail('npm run users -- login-link <username|e-mail|name>');
  const account = findAccount(handle);
  if (!account) fail(`No account "${handle}". See: npm run users -- list`);
  if (!account.active) fail(`"${account.username}" is disabled`);

  const { token, code } = issueLoginToken(account.id, { ip: 'command line' });
  const link = signInLink(token);
  console.log(`\nFor ${account.name} (${account.username}), once, within ${TOKEN_MINUTES} minutes:\n`);
  if (link) console.log(`  ${link}\n`);
  else console.log('  (no link: set PUBLIC_URL in .env, e.g. https://tracker.example.com)\n');
  if (account.email) console.log(`  or on the sign-in page: e-mail ${account.email}, code ${code}\n`);
}

const COMMANDS = { list, add, 'set-email': setEmail, 'login-link': loginLink };
if (!COMMANDS[command]) {
  console.error(`npm run users -- <${Object.keys(COMMANDS).join('|')}>  (details at the top of scripts/users.js)`);
  process.exit(1);
}
COMMANDS[command]();
