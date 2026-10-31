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
HOST=127.0.0.1
TRUST_PROXY=1
PUBLIC_URL=https://tracker.example.com
ADMIN_EMAIL=<your own e-mail address>

# Outgoing mail - see "E-mail" below
SMTP_HOST=127.0.0.1
SMTP_PORT=25
MAIL_FROM="Integration Tracker <noreply@example.com>"
```

There are no passwords. Everybody signs in by typing their e-mail address and
following the link, or typing the code, from the message that arrives - so the
server has to be able to send e-mail before anybody can get in.
`PUBLIC_URL` is where the link in that message points; it is never taken from
the request, because a forged Host header would otherwise let someone have a
real sign-in link mailed out pointing at their own server. `ADMIN_EMAIL` gives
the seeded admin account your address.

`TRUST_PROXY=1` matters: without it the app sees nginx as the client, so
sign-in throttling counts everyone as one address.

`HOST=127.0.0.1` keeps the Node port off the public network, so the only way in
is through nginx and its certificate. Leave it out only while you run without
nginx and open `http://<server-ip>:4000` directly.

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

### Moving an existing installation from `http://<ip>:4000` to a domain

The data stays where it is; only the way in changes.

1. The domain's A record points at the server (`dig +short <domain>` on your
   own machine shows the server's IP). Ports 80 and 443 are open in any
   firewall in front of the server, including the hosting provider's.
2. Run the nginx and certbot steps above with your domain.
3. In `.env`: add `HOST=127.0.0.1` and `TRUST_PROXY=1`, and remove
   `INSECURE_COOKIES=1` if it is there. Then
   `sudo systemctl restart integration-tracker`.
4. `http://<ip>:4000` stops answering - that is the point. Everybody signs in
   once more at `https://<domain>`; the old session cookie belonged to the IP.
5. Settings -> Daily digest -> Tracker address: `https://<domain>`, so the
   links in the Slack/Teams message lead to the new address.

### E-mail

Sign-in e-mails go out over SMTP. Either a Postfix on this server, which the
included script sets up, or any provider's relay (`SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE=1` for port 465).

On this server:

```bash
cd /opt/integration-tracker
sudo bash deploy/setup-mail.sh example.com
```

It installs Postfix listening on 127.0.0.1 only (nothing is received, nothing is
reachable from outside), signs every message with DKIM, checks whether outgoing
port 25 is open, and prints what is left to do by hand:

- three TXT records - SPF, DKIM, DMARC - for the domain;
- the server's reverse DNS (PTR) set to `mail.example.com` at the hosting
  provider, and an A record for that name;
- the `.env` lines above.

Mail from a server without those lands in spam or is refused. An MX record is
not needed for sending.

Hetzner blocks outgoing port 25 on new cloud servers; the script says so if it
is. Ask Hetzner to lift it, or use a relay on port 587 instead.

Then `sudo systemctl restart integration-tracker` and, once signed in,
Settings → Sign-in e-mails → "Send a test e-mail".

## 7. First sign-in

Open `https://tracker.example.com`, enter the address from `ADMIN_EMAIL` and
sign in from the e-mail. If no e-mail arrives, get in without one and look at
the mail setup from inside:

```bash
cd /opt/integration-tracker
sudo -u tracker -H npm run users -- login-link admin
```

That prints a link and a code, valid once for an hour. It needs nothing but the
server, so it is also the way back in whenever mail is down. Then:

1. Settings → Sign-in e-mails → send yourself a test e-mail.
2. Create the accounts - in Settings, one at a time, or several at once:

   ```bash
   sudo -u tracker -H npm run users -- add --role partner --company Primis \
     "Omer Peleg <omerp@example.com>" "Gabriel Neumann <gabrieln@example.com>"
   ```

   An account that already exists under that address, username or name is
   completed instead of created twice; `--dry-run` only reports.
3. Settings → disable the seeded `dev`, `dev-extern` and `primis-qa` accounts.
   They sit on placeholder `.test` addresses, so nobody can sign in with them,
   but there is no reason to keep them.
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
is responsible for what.

Only then send the link to the partner.

## 8. Backups

Everything lives under `data/`. The included script keeps 30 daily copies of the
database, the attachments and `.env` (which holds the mail and proxy settings
and exists nowhere else):

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

Every command runs **as `tracker`**, not as root. The files belong to `tracker`,
and git refuses to work in a directory somebody else owns:

```bash
cd /opt/integration-tracker
sudo -u tracker -H git pull
sudo -u tracker -H npm ci
sudo -u tracker -H npm run build
sudo systemctl restart integration-tracker
```

If you already ran one of them as root, put the ownership back first -
otherwise the next `sudo -u tracker npm ci` fails on a `node_modules` it cannot
write:

```bash
sudo chown -R tracker:tracker /opt/integration-tracker
```

Schema changes apply themselves on start-up, and they only ever add - no
migration drops a column or a row. (One clears values: the update to e-mail
sign-in empties the stored password hashes, since nothing reads them any more.)
`npm run seed` is additive too, so re-running it after an update picks up newly
listed domains and leaves everything you have edited alone.

### The update that brings e-mail sign-in

From this version on there are no passwords; the old ones stop working the
moment the new version starts. Before restarting into it:

1. Set up mail and add the `.env` lines (see "E-mail" in section 6), including
   `PUBLIC_URL`.
2. Give your own account your real address - the seed gave it a placeholder:
   `sudo -u tracker -H npm run users -- set-email admin you@example.com`
3. `sudo -u tracker -H npm run users -- list` shows every account; anyone
   flagged "no real address" cannot sign in until their address is set.

Everybody who was signed in stays signed in until their session runs out; new
sessions last seven days.

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
| 502 from nginx | the service is down, or `PORT` in `.env` does not match `proxy_pass`, or `HOST` is set to something other than `127.0.0.1` |
| certbot fails with "Timeout during connect" or "unauthorized" | Port 80 is closed somewhere in front of the server, or the domain does not yet resolve to it everywhere - certbot checks from several places on the internet. Wait for the DNS TTL and try again |
| `nginx -t` fine, but the domain shows a parking page | DNS still points at the old address in that resolver's cache; a few minutes up to the record's TTL |
| 413 when uploading a file | `client_max_body_size` missing from the nginx server block, or below the 25 MB app limit |
| A domain has vanished from the list | It was archived. Open it directly at `/sites/<id>`, or tick "Show archived" on the Sites page, and use "Bring it back" |
| The dashboard and the issue list show different counts | They should not any more; both exclude archived domains. Tick "Include archived domains" on the Issues page to see the rest |
| Sign-in says "too many attempts" for everyone | `TRUST_PROXY=1` missing from `.env` |
| "Sign-in by e-mail is not set up on this server yet" | `SMTP_HOST` or `MAIL_FROM` missing from `.env`, or the service was not restarted after adding them |
| The sign-in e-mail never arrives | Settings → Sign-in e-mails → test e-mail, then `sudo journalctl -u postfix -n 50`. "Connection timed out" to port 25: the hoster blocks it. "550 ... SPF/DKIM": the DNS records or the PTR are missing. Also check the person's spam folder, and that their address in Settings is spelt right |
| Locked out, mail is down | `sudo -u tracker -H npm run users -- login-link <you>` prints a one-time link and code |
| "Signing in from this connection is blocked until ..." | Three failed sign-ins from that address in 24 hours. Settings -> Blocked connections -> Lift, or `sudo -u tracker -H npm run users -- unblock <ip>` (`blocks` lists them). If it hits everybody at once, `TRUST_PROXY=1` is missing and every visitor looks like nginx |
| The link in the e-mail points to the wrong place | `PUBLIC_URL` in `.env` |
| The link says "expired or was already used" on first click | The company mail filter opened it first - that is why the page asks for a click instead of signing in on opening. If it still happens, type the code |
| `fatal: detected dubious ownership` on `git pull` | You are root in a directory owned by `tracker`. Use `sudo -u tracker -H git pull`. Do not add a `safe.directory` exception: running git as root here leaves root-owned files behind, and the service cannot write them |
| `npm error Missing script` right after an update | The `git pull` before it failed, so the new code never arrived. With `a && b` a failed `a` stops `b` - scroll up and read the first error, not the last |
| `EACCES` from `npm ci` | Something was run as root earlier. `sudo chown -R tracker:tracker /opt/integration-tracker` |
| Sign-in works but every page is empty | old build: the session cookie was dropped over plain HTTP. `git pull` and rebuild |
| The daily digest never arrives | Settings shows the last attempt and its error. A quiet day sends nothing by design; otherwise it is usually outbound HTTPS being blocked, or a webhook the channel has revoked |
| Exchange rate stuck at 1.08 | the server cannot reach `ecb.europa.eu`; set the rate by hand under Settings |
