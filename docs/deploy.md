# Installing on a server

Written for a fresh Ubuntu 22.04/24.04 or Debian 12 VPS with root access. Adjust
the domain, and skip the nginx/TLS section if you only want it reachable inside
a VPN or on a LAN.

Copy-paste block by block and check the output as you go.

## 1. Node 22

The tracker needs Node 22.5 or newer for the built-in SQLite module. Distro
packages are usually older, so install from NodeSource:

```bash
sudo apt update && sudo apt install -y curl git ca-certificates sqlite3
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v        # must print v22.5.0 or higher
```

## 2. A user and the code

Running as root is not necessary, so give it its own unprivileged account:

```bash
sudo adduser --system --group --home /opt/integration-tracker --shell /bin/bash tracker
sudo git clone -b claude/primis-pages-tracking-tool-6pe12f \
  https://github.com/admncc/integration-tracker.git /opt/integration-tracker
sudo chown -R tracker:tracker /opt/integration-tracker
```

For a private repository, clone over SSH with a deploy key instead, or clone as
your own user and `chown` afterwards.

The `-H` in the commands below matters: without it `sudo` keeps `HOME=/root`,
which the `tracker` user cannot write to, and npm fails on its cache.

## 3. Configure

```bash
cd /opt/integration-tracker
sudo -u tracker -H cp .env.example .env
sudo -u tracker -H nano .env
```

Set at least:

```ini
PORT=4000
TRUST_PROXY=1
SEED_PASSWORD=<a long password you choose>
```

`TRUST_PROXY=1` matters: without it the app sees nginx as the client, so
sign-in throttling counts everyone as one address.

`.env` is read both by the service and by `npm run seed`, as long as you run
them from `/opt/integration-tracker`. Anything already set in the environment
wins over the file.

## 4. Install, build, seed

```bash
cd /opt/integration-tracker
sudo -u tracker -H npm ci
sudo -u tracker -H npm run build
sudo -u tracker -H npm run seed
```

The seed prints the accounts it created and is safe to re-run: it only ever adds
rows, so a later `git pull` can bring in new domains without resetting a status
somebody moved by hand. `npm run build` must be re-run after every `git pull`,
otherwise the browser keeps serving the old interface.

Quick check before setting up the service:

```bash
sudo -u tracker -H env NODE_ENV=production PORT=4000 node server/index.js
# expect: "Integration Tracker API on http://localhost:4000"
#         "FX rate 1.16... USD/EUR (ECB ...)"
# Ctrl-C to stop
```

## 5. Run it as a service

```bash
sudo cp /opt/integration-tracker/deploy/integration-tracker.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now integration-tracker
sudo systemctl status integration-tracker --no-pager
```

Logs: `sudo journalctl -u integration-tracker -f`

## 6. nginx and a certificate

Point an A record for your subdomain at the server first - certbot verifies
over HTTP and fails if DNS has not propagated.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp /opt/integration-tracker/deploy/nginx.conf.example \
  /etc/nginx/sites-available/integration-tracker
sudo nano /etc/nginx/sites-available/integration-tracker   # replace the domain
sudo ln -s /etc/nginx/sites-available/integration-tracker \
  /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d tracker.example.com
```

Certbot renews on its own via a systemd timer.

### Firewall

If ufw is active, the Node port must stay closed to the outside - only nginx
should reach it:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 7. First sign-in

Open `https://tracker.example.com`, sign in as `admin` with the password from
`SEED_PASSWORD`, then:

1. Settings → change your own password.
2. Settings → create an account for each developer and for the Primis contacts.
3. Settings → disable the seeded `dev`, `dev-extern` and `primis-qa` accounts, or
   set fresh passwords on them. All four were created with the same
   `SEED_PASSWORD`, so leaving one untouched leaves a known password on the box.
4. Settings → check the EUR/USD rate says "European Central Bank" - that
   confirms the server can reach the outside world.
5. Settings → make somebody responsible for the domains. Create the accounts
   first, then hand the active ones over in one command - it uses the account
   that is already there and leaves the priority-99 pile alone:

   ```bash
   cd /opt/integration-tracker
   sudo -u tracker -H npm run assign-owner -- --list          # who there is
   sudo -u tracker -H npm run assign-owner -- <username>      # hand them over
   ```

   `--dry-run` says what it would do without doing it, and running it twice
   changes nothing the second time. Afterwards it is edited per domain on the
   domain's own page, or across a selection on the Sites page.
6. Settings → Daily digest: paste a Slack or Teams incoming webhook and the
   tracker's own address, then press "Send one now" to check it arrives. This is
   what tells both sides it is their turn; without it people fall back to
   e-mail. Outbound HTTPS to the webhook host has to be open.

`npm run seed` never creates an account for a real person and never decides who
is responsible for what: the four accounts it makes share a published default
password, which is fine for an empty install and wrong for anybody real.

Only then send the link to the partner.

## 8. Backups

Everything lives under `data/`. The included script keeps 30 daily copies of the
database, the attachments and `.env` (which holds the seed password and the
proxy settings and exists nowhere else):

```bash
sudo mkdir -p /var/backups/integration-tracker
sudo crontab -e
# add:
0 3 * * * /opt/integration-tracker/deploy/backup.sh
```

The script prints how many sites and issues the copy holds, and fails loudly if
the copy does not open. A backup that printed nothing but "Backed up to ..." is
not evidence of anything - read the counts.

### Restoring

**Delete the WAL files.** This is the step that decides whether a restore works.
SQLite keeps recent writes in `tracker.db-wal` beside the database, and it
replays them over whatever file it finds. Copy a backup over `tracker.db` with
the old `-wal` still there and SQLite quietly puts you back exactly where you
started - `PRAGMA integrity_check` says `ok`, the app starts, and everything you
were trying to undo is still in it.

```bash
sudo systemctl stop integration-tracker
cd /opt/integration-tracker/data

sudo -u tracker -H cp /var/backups/integration-tracker/tracker-<stamp>.db tracker.db
sudo -u tracker -H rm -f tracker.db-wal tracker.db-shm     # <- not optional

sudo -u tracker -H rm -rf uploads
sudo -u tracker -H tar -xzf /var/backups/integration-tracker/uploads-<stamp>.tar.gz

sudo systemctl start integration-tracker
```

Then **verify before telling anyone it worked** - sign in, open the Sites page
and check the site count and the open-issue count against what the backup
printed when it was taken:

```bash
sudo -u tracker -H node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/opt/integration-tracker/data/tracker.db", { readOnly: true });
  console.log(db.prepare("SELECT COUNT(*) AS sites FROM sites").get());
  console.log(db.prepare("SELECT COUNT(*) AS issues FROM issues").get());
'
```

`.env` is not restored by the steps above - if you lost it, copy `env-<stamp>`
from the backup directory back to `/opt/integration-tracker/.env` and
`chmod 600` it.

## Updating

```bash
cd /opt/integration-tracker
sudo -u tracker -H git pull
sudo -u tracker -H npm ci
sudo -u tracker -H npm run build
sudo systemctl restart integration-tracker
```

Schema changes apply themselves on start-up, and they only ever add - no
migration drops a column or a row. `npm run seed` is additive too, so re-running
it after an update picks up newly listed domains and leaves everything you have
edited alone.

**Take the backup before the update, not after**, and check it printed its
counts. If the service does not come back:

```bash
sudo journalctl -u integration-tracker -n 50 --no-pager
```

A migration that cannot complete exits before the server listens, and
`Restart=always` then retries every five seconds - so a boot failure looks like
a restart loop rather than a single error. The log line names the cause. To go
back while you work it out:

```bash
sudo systemctl stop integration-tracker
cd /opt/integration-tracker
sudo -u tracker -H git checkout <the previous tag or commit>
sudo -u tracker -H npm ci && sudo -u tracker -H npm run build
# then restore the pre-update database, WAL deletion included - see "Restoring"
sudo systemctl start integration-tracker
```

Rolling the code back on its own is not always enough: once a migration has run,
the database is on the new schema. Restore the backup as well.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `node -v` shows v18 or v20 | NodeSource step did not take; the app will not start |
| Service restarts in a loop | `journalctl -u integration-tracker -n 50`. A bad `.env` line, `data/` not writable by `tracker`, or a migration that could not finish - the log names it. See "Updating" for going back |
| A restore brought back the data you were trying to undo | `tracker.db-wal` was left in place and SQLite replayed it. Stop the service, restore again, delete `tracker.db-wal` and `tracker.db-shm`, start |
| Everything reads fine but nothing saves, and sign-in 500s | The disk is full. `df -h`, then clear space - old backups, `journalctl --vacuum-time=7d`. Reads keep working, so the app looks alive; writes, sessions and sign-in do not. Nothing is corrupted and it recovers as soon as there is space |
| 502 from nginx | the service is down, or `PORT` in `.env` does not match `proxy_pass` |
| 413 when uploading a file | `client_max_body_size` missing from the nginx server block, or below the 25 MB app limit |
| A domain has vanished from the list | It was archived. Open it directly at `/sites/<id>`, or tick "Show archived" on the Sites page, and use "Bring it back" |
| The dashboard and the issue list show different counts | They should not any more; both exclude archived domains. Tick "Include archived domains" on the Issues page to see the rest |
| Sign-in says "too many attempts" for everyone | `TRUST_PROXY=1` missing from `.env` |
| Sign-in works but every page is empty | old build: the session cookie was dropped over plain HTTP. `git pull` and rebuild |
| The daily digest never arrives | Settings shows the last attempt and its error. A quiet day sends nothing by design; otherwise it is usually outbound HTTPS being blocked, or a webhook the channel has revoked |
| Exchange rate stuck at 1.08 | the server cannot reach `ecb.europa.eu`; set the rate by hand under Settings |
