/**
 * Makes one person responsible for a set of domains, on a database that is
 * already in use.
 *
 * `npm run seed` also does this, but it is the wrong tool once a tracker is
 * live: it wants to add its own users and its own domains too. This touches
 * nothing but the owner column, says exactly what it changed, and can be run
 * again without doing it twice.
 *
 *   npm run assign-owner -- omery              # every active domain with no owner
 *   npm run assign-owner -- "Omer Yahav"       # by name, if the username differs
 *   npm run assign-owner -- omery --all        # take over the ones that have an owner too
 *   npm run assign-owner -- omery --dry-run    # say what it would do, change nothing
 *   npm run assign-owner -- --clear            # release every domain
 *   npm run assign-owner -- --list             # who could hold a domain
 */
import '../server/lib/env.js';

const { db } = await import('../server/lib/db.js');
const { INACTIVE_PRIORITY } = await import('../shared/domain.js');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const who = args.find((a) => !a.startsWith('--')) ?? '';

const dryRun = flags.has('--dry-run');
const takeOver = flags.has('--all');
const clear = flags.has('--clear');

function listPeople() {
  const people = db.prepare('SELECT id, username, name, company, role, active FROM users ORDER BY company, name').all();
  console.log('\nWho could hold a domain:\n');
  for (const person of people) {
    const held = db.prepare('SELECT COUNT(*) AS n FROM sites WHERE owner_id = ? AND archived = 0').get(person.id).n;
    console.log(
      `  ${person.username.padEnd(14)} ${person.name.padEnd(16)} ${(person.company || '-').padEnd(12)} ` +
        `${person.role.padEnd(8)} ${person.active ? '' : '(disabled) '}${held ? `holds ${held} domain(s)` : ''}`
    );
  }
  console.log('');
}

if (flags.has('--list')) {
  listPeople();
  process.exit(0);
}

if (!clear && !who) {
  console.error('Name the person: npm run assign-owner -- omery');
  console.error('Or see who there is: npm run assign-owner -- --list');
  process.exit(1);
}

/*
 * Username first, then the display name, because whoever created the account by
 * hand chose the username and it may not be the one the seed would have picked.
 */
let person = null;
if (!clear) {
  person =
    db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(who) ??
    db.prepare('SELECT * FROM users WHERE lower(name) = lower(?)').get(who) ??
    null;

  if (!person) {
    console.error(`No account matches "${who}" - neither as a username nor as a name.`);
    listPeople();
    process.exit(1);
  }
  if (!person.active) {
    console.error(`${person.name} (${person.username}) is disabled and cannot be handed a domain.`);
    process.exit(1);
  }
}

/*
 * Priority 99 is the parked pile: nobody is answerable for a domain nobody is
 * working on, so it stays out unless the whole thing is being cleared.
 */
const scope = clear
  ? 'archived = 0'
  : `archived = 0 AND priority < ${INACTIVE_PRIORITY}${takeOver ? '' : ' AND owner_id IS NULL'}`;

const affected = db.prepare(`SELECT id, domain, owner_id FROM sites WHERE ${scope} ORDER BY priority, domain`).all();
const changing = affected.filter((site) => (clear ? site.owner_id != null : site.owner_id !== person.id));

if (changing.length === 0) {
  console.log(clear ? 'No domain has an owner to release.' : `Nothing to do - ${person.name} already holds all of them.`);
  process.exit(0);
}

console.log(
  clear
    ? `Releasing ${changing.length} domain(s):`
    : `Making ${person.name} (${person.username}, ${person.company || 'no company'}) responsible for ${changing.length} domain(s):`
);
for (const site of changing.slice(0, 10)) console.log(`  ${site.domain}`);
if (changing.length > 10) console.log(`  ... and ${changing.length - 10} more`);

if (dryRun) {
  console.log('\n--dry-run: nothing was changed.');
  process.exit(0);
}

// One transaction, and one activity row per domain: a sweep this size should be
// readable afterwards on each domain's own history.
const update = db.prepare('UPDATE sites SET owner_id = ?, updated_at = datetime(\'now\') WHERE id = ?');
const record = db.prepare(
  `INSERT INTO activity (site_id, actor_id, kind, field, old_value, new_value)
   VALUES (?, NULL, 'site_updated', 'owner_id', ?, ?)`
);

db.exec('BEGIN');
try {
  for (const site of changing) {
    update.run(clear ? null : person.id, site.id);
    record.run(site.id, site.owner_id == null ? null : String(site.owner_id), clear ? null : String(person.id));
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

const parked = db
  .prepare(`SELECT COUNT(*) AS n FROM sites WHERE archived = 0 AND priority >= ${INACTIVE_PRIORITY} AND owner_id IS NULL`)
  .get().n;

console.log(`\nDone. ${changing.length} domain(s) changed.`);
if (!clear && parked) console.log(`${parked} parked domain(s) at priority ${INACTIVE_PRIORITY} were left unowned.`);
