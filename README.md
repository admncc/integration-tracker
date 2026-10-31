# Integration Tracker

<img src="client/public/logo.svg" width="48" alt="Digital Marketing Corp">

*by Digital Marketing Corp.* The logo lives in `client/public/`: `logo.svg` (the
mark, also the favicon), `logo-full.svg` (mark with the company name),
`logo-512.png` and `apple-touch-icon.png`. Inside the app it is drawn by
`client/src/components/Logo.tsx`.

A shared workspace for rolling sites out with a demand partner. It replaces the
Google Sheet plus e-mail thread: every domain has a status per integration
track, the partner raises QA issues against a specific domain, developers work
them off, and the partner ticks them off after a re-check.

Built for the Primis rollout, but nothing in it is Primis-specific.

## What it does

**Potential projects** - the first tab under Sites: candidate domains before
any of them becomes a project. Paste a list or load a .txt file (one domain per
line; commas, spaces and full URLs work too). Each domain carries two statuses
that move independently - a **project status** (NEW, LIVE, REMOVED) and a
**domain status** (NEW, DOMAIN SUBMITTED FOR APPROVAL, GOOD, MOSTLY BLOCKED) -
changed per row or across a selection. A star marks **high potential**: those
rows are highlighted and always listed first, whatever was pasted after them.
Repeats, domains already on the list and domains that are already tracked sites
are skipped and reported. A project status of REMOVED keeps the record that a
domain was looked at; "Delete from list" is for a paste that went wrong. The
list is kept apart from the sites table on purpose, so a batch of candidates
never reaches the rollout numbers, the dashboard or anybody's "waiting on you".

**Sites** - one row per domain, with the five tracks from the old sheet (video,
display, ads.txt, ad tag, MCM) plus CMP and partner approval. Every cell is
editable in place, every column filterable and sortable. Domains can be added,
archived (reversible, from the domain's own page) or deleted permanently.
Clicking a domain opens its detail page, where the test URL sits at the top - it
is the first thing either side reaches for.

Every domain can have somebody **responsible** for it - a real person in the
tool, on either side. Primis own their steps of a rollout, so the domains being
rolled out sit with them; their header then counts how many of theirs are not
live yet. It is set on the domain's own page, or across a selection at once - or, for a
whole rollout in one go, with `npm run assign-owner -- <username or name>`,
which uses the account that is already there and leaves the parked domains
alone. The
table has no column for it: the grid has to fit without sideways scrolling, and
a name costs more width than it earns in a list you scan for status.

**Mostly blocked by demand partners** - the flag next to each domain. When the
demand side refuses most of a site's traffic, the partner flags it: the row
turns red, a red banner above the table lists it, and the publisher's "waiting
on you" and the daily digest lead with it. The publisher takes the site offline
and marks it **Taken offline**, which ends the alert and keeps the record (the
row is struck through and greyed). Only the publisher can say a site is offline;
either side can withdraw a flag. Who flagged it and since when sits next to it,
and every change is in the domain's history.

Tick several rows and one column can be set across all of them at once - "these
twelve went live on display today" is one action rather than twelve cell edits.
It changes one column at a time and asks first, and each domain's own history
still records who moved what, from what, and when.

Above the table sits **network-wide**: the things that are not about one domain.
An issue raised there is either ticked off once for the whole network, or
created on every active domain at once so it has to be ticked off on each of
them - the band then shows how many are done.

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

          ↘ blocked (waiting on a third party, not terminal)
          ↘ won't fix (developer or admin, terminal)
```

**Blocked** is the state nobody on either side owns: the work is real, it is
nobody's turn, and it is waiting on something outside both companies - a
contract, an approval queue, the client's own developer. It records *on whom*
and *since when*, so "what are we blocked on, and how long has it been" is one
click on the dashboard rather than a question nobody can answer.

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

## Signing in

There are no passwords. On the sign-in page you enter your e-mail address and
get a message with a link and a six-digit code. Either works once, within an
hour; signing in spends both. A sign-in lasts seven days on that device.

- The link opens the sign-in page and signs in on a click, not on opening: mail
  filters open every link in a message before the recipient does.
- The code is for signing in on a different device than the one reading mail.
- The page says the same whether or not the address has an account. Five wrong
  codes spend that person's open codes; one address gets at most five e-mails
  an hour; one connection is slowed down after repeated failures.
- An admin creates accounts with a name and an address (Settings, or
  `npm run users -- add`). Changing someone's address signs them out
  everywhere.

## Roles

| Role | Can |
| --- | --- |
| **Admin** | everything, plus users and the exchange rate |
| **Developer** | edit sites, work issues, hand them back for re-check |
| **Demand partner** | edit every column on the sites table, raise and verify issues |

The partner edits the sites table exactly as the publisher's own team does.
That is deliberate: Primis runs the QA and is closest to what the tags are
actually doing, so making them ask for a status change they have already
verified only slows the rollout down. The trade is that a track can be set to
Live by the company whose integration it is - what the separation rests on is
the audit trail, which carries every change with a name and a time on the
domain's own page.

Two things stay with the publisher: **archiving or deleting a domain**, which
takes it out of the list for everyone, and **user accounts and the exchange
rate**, which are admin-only.

**Anyone can be an assignee**, on either side of the table. The partner has
their own steps in a rollout - approving a domain with their demand partners,
generating the display tags - so a task can sit on them the same way it sits on
a developer, and it shows up in their "waiting on you".

Role governs what you may do to *somebody else's* work; being the assignee lets
you drive your own. Whoever an issue is on can move it through open → in
progress → blocked → ready for re-check whatever company they work for, and can
schedule it or hand it on.

The rest of the roles still differ: no developer can mark anything **verified** -
only the partner or an admin can, and being the assignee does not change that -
and nobody rewrites the text of somebody else's finding. Both are enforced server-side, not just
hidden in the interface. A developer can close an issue as **won't fix**, which
is terminal too; that is deliberate, so a finding the publisher disagrees with
does not sit open forever, and it shows in the history with their name on it.

## Knowing it is your turn

Every handoff here crosses a company boundary, so the tool has to say whose turn
it is - otherwise the mail thread survives as the notification layer and the
tracker becomes a record written after the fact.

- **In the header**, a "waiting on you" count: for the partner, fixes to
  re-check; for a developer, issues assigned to them plus the unowned backlog;
  for everyone, discussion messages they have not seen.
- **A daily digest** into Slack or Teams, if an admin sets an incoming webhook
  under Settings: what was raised, handed back and verified in the last 24
  hours, what is waiting on whom, and what is blocked. A quiet day sends
  nothing. There is a preview and a "send one now" button, so you can see what
  it says before trusting it.

Per-user e-mail is deliberately not built: it needs SMTP, an address list
(`users.email` is optional), unsubscribe handling and per-event preferences, for
less benefit than one webhook into the channel people already watch.

## Running it

Requires Node 22.5 or newer (the built-in `node:sqlite` module). No database
server, no native build step.

```bash
npm install
npm run seed        # current sites, RPM figures and the open QA findings
npm run dev         # API on :4000, UI on :5173
```

`npm run seed` only ever adds rows, so it is safe to re-run after an update.

Sign in by e-mail: enter `admin@publisher.test` (or the `ADMIN_EMAIL` you set
before seeding). Without `SMTP_HOST` in development the message is printed in
the API's console instead of being sent - copy the code or the link from there.
`npm run users -- login-link admin` prints a link without any e-mail at all.

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
| `UPLOAD_DIR` | `data/uploads` | where issue and comment attachments are stored |
| `TRUST_PROXY` | unset | set to `1` behind a reverse proxy |
| `DISABLE_FX_REFRESH` | unset | set to `1` to never call the ECB |
| `INSECURE_COOKIES` | unset | set to `1` only to run production over plain HTTP |
| `HOST` | every interface | `127.0.0.1` behind nginx |
| `PUBLIC_URL` | unset | the tracker's address, for the link in sign-in e-mails |
| `SMTP_HOST`, `SMTP_PORT` | unset, `25` | where e-mail is handed over; `deploy/setup-mail.sh` sets up a local Postfix |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | unset | for a relay that wants a login; `SMTP_SECURE=1` for TLS from the start |
| `MAIL_FROM` | unset | sender of the sign-in e-mails |
| `ADMIN_EMAIL` | placeholder | the seeded admin account's address |

Everything worth keeping lives under `data/` - back up that directory and you
have the whole tracker.

## Layout

```
server/          Express API, plain ESM, no build step
  lib/db.js      schema, migrations, activity log
  lib/auth.js    cookie sessions (7 days), role guards
  lib/login.js   sign-in e-mails: link and code, hashed, one hour, one use
  lib/mail.js    SMTP via nodemailer
  lib/sheet.js   CSV parsing and the Google Sheet vocabulary
  lib/fx.js      ECB daily reference rate
  lib/uploads.js attachment storage
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
