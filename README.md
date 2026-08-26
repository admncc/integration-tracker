# Integration Tracker

A shared workspace for rolling sites out with a demand partner. It replaces the
Google Sheet plus e-mail thread: every domain has a status per integration
track, the partner raises QA issues against a specific domain, developers work
them off, and the partner ticks them off after a re-check.

Built for the Primis rollout, but nothing in it is Primis-specific.

## What it does

**Sites** - one row per domain, with the five tracks from the old sheet (video,
display, ads.txt, ad tag, MCM) plus CMP, partner approval and notes. Every cell
is editable in place, every column filterable and sortable. Domains can be
added, archived or deleted. Clicking a domain opens its detail page, where the
test URL sits at the top - it is the first thing either side reaches for.

Each domain carries a traffic light, and it means one thing everywhere in the
tool:

| | |
| --- | --- |
| 🟢 green | all five tracks are **1 - Live** |
| 🔴 red | at least one track is not; the detail page names which |
| ⚪ grey | priority 99 - listed, but not part of the active rollout |

Open issues are a separate signal: the issue count in its own column, and a
tinted row.

The table is sized in percentages, so it fits the screen at any width without
scrolling sideways. Anything that does not survive that budget lives on the
detail page: managed by, the discussion, and deleting the site.

The legend above the table doubles as a filter - click *Not fully live* to see
only the domains still being worked on.

**Issues** - raised against a domain, with a type (*technical* or *revenue*), a
category, a severity, an assignee and a due date. Screenshots can be attached to
the issue and to any comment. Comments carry the author and a full timestamp.

**Discussion** - every domain has a thread of its own, for the questions that
are not defects: is this site AMP only, when does the old contract run out, is
this placement intentional. Anyone with access can post and reply, replies quote
what they answer, and new messages surface in the activity feed.

The QA loop is the status flow:

```
open → in progress → ready for re-check → verified
         (developer)      (developer)      (partner)
```

A partner can reopen a verified issue; the card then shows which QA round the
issue is on, so an item that keeps bouncing back is visible rather than buried
in a mail thread.

**One finding, many domains** - the case the mail thread kept getting wrong
("the player is in `<head>` on these 13 sites") becomes one write: select the
domains in the list, raise one issue, and each domain gets its own tickable item
grouped under a shared batch.

**Revenue** - two hand-entered figures per site, *Previous Session RPM* and
*Primis Session RPM*, each in its own currency because the two providers report
differently. Everything comparable is normalised to EUR through the European
Central Bank's daily reference rate, pulled automatically on start-up and every
twelve hours. The dashboard shows where Primis beats the previous setup and
where it does not - visible to the partner as well as to you.

**Import / export** - paste a CSV export of the old sheet and it upserts by
domain; the sheet's own wording ("1 - LIVE", "4 - Tags prep", "€3.13", "$2.00")
is understood. Sites and issues both export back to CSV.

## Roles

| Role | Can |
| --- | --- |
| **Admin** | everything, plus users and the exchange rate |
| **Developer** | edit sites, work issues, hand them back for re-check |
| **Demand partner** | raise and verify issues, set approval and the Primis RPM |

The partner cannot edit track statuses or the previous-setup RPM, and a
developer cannot verify their own fix. Both rules are enforced server-side, not
just hidden in the interface.

## Running it

Requires Node 22.5 or newer (the built-in `node:sqlite` module). No database
server, no native build step.

```bash
npm install
npm run seed        # current sites, RPM figures and the open QA findings
npm run dev         # API on :4000, UI on :5173
```

`npm run seed` only ever adds rows, so it is safe to re-run after an update.

Sign in with `admin` / `changeme123`. The seed also creates `dev`, `dev-extern`
and `primis-qa` with the same password - **change them before the partner gets a
link.**

For production:

```bash
npm run build       # bundles the UI into dist/
npm start           # one process serves the API and the UI on :4000
```

Put it behind a TLS-terminating reverse proxy and set `TRUST_PROXY=1` so client
IPs and secure cookies are correct. **[docs/deploy.md](docs/deploy.md)** walks
through a full server install step by step - Node, a service user, systemd,
nginx, a certificate and backups. Ready-made unit and nginx files are in
`deploy/`.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `DATABASE_PATH` | `data/tracker.db` | SQLite file |
| `UPLOAD_DIR` | `data/uploads` | where screenshots are stored |
| `TRUST_PROXY` | unset | set to `1` behind a reverse proxy |
| `DISABLE_FX_REFRESH` | unset | set to `1` to never call the ECB |
| `INSECURE_COOKIES` | unset | set to `1` only to run production over plain HTTP |
| `SEED_PASSWORD` | `changeme123` | password the seed gives its accounts |

Everything worth keeping lives under `data/` - back up that directory and you
have the whole tracker.

## Layout

```
server/          Express API, plain ESM, no build step
  lib/db.js      schema, migrations, activity log
  lib/auth.js    scrypt passwords, cookie sessions, role guards
  lib/sheet.js   CSV parsing and the Google Sheet vocabulary
  lib/fx.js      ECB daily reference rate
  lib/uploads.js screenshot storage
  routes/        auth, sites, issues, meta (stats, users, import/export)
shared/domain.js statuses, categories, currency helpers - used by both sides
client/          React + Vite + Tailwind
scripts/seed.js  current rollout state
test/            node:test suites for the pure logic
```

`npm test` runs the unit tests. They cover the sheet parsing and the currency
maths - the two places where a silent mistake would corrupt real numbers.

## Not built yet

- **Notifications.** Nothing is pushed anywhere; people see new issues when they
  open the tool. An e-mail or Slack digest of "opened / handed back / verified
  today" would be the natural next step, and needs SMTP or a webhook URL.
- **Automated checks.** The tracker records what QA found; it does not fetch a
  test URL to verify a tag position itself. Worth adding once the manual loop
  settles, since the recurring findings (player in `<head>`, duplicate slot IDs,
  leftover units) are all machine-checkable.
- **Revenue import.** RPM figures are typed in by hand. If the reporting side
  offers an API, that column could fill itself.
