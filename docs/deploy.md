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
#         "FX rate 1.16… USD/EUR (ECB …)"
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
   set fresh passwords on them.
4. Settings → check the EUR/USD rate says "European Central Bank" - that
   confirms the server can reach the outside world.

Only then send the link to the partner.

## 8. Backups

Everything lives under `data/`. The included script keeps 30 daily copies:

```bash
sudo mkdir -p /var/backups/integration-tracker
sudo crontab -e
# add:
0 3 * * * /opt/integration-tracker/deploy/backup.sh
```

Restoring is a file copy: stop the service, put `tracker.db` back into
`data/`, unpack the uploads tarball next to it, start the service.

## Updating

```bash
cd /opt/integration-tracker
sudo -u tracker -H git pull
sudo -u tracker -H npm ci
sudo -u tracker -H npm run build
sudo systemctl restart integration-tracker
```

Schema changes apply themselves on start-up. `npm run seed` is additive, so
re-running it after an update picks up newly listed domains and leaves
everything you have edited alone. Take a backup before an update anyway.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `node -v` shows v18 or v20 | NodeSource step did not take; the app will not start |
| Service restarts in a loop | `journalctl -u integration-tracker -n 50` - usually a bad `.env` line or `data/` not writable by `tracker` |
| 502 from nginx | the service is down, or `PORT` in `.env` does not match `proxy_pass` |
| 413 when uploading a screenshot | `client_max_body_size` missing from the nginx server block |
| Sign-in says "too many attempts" for everyone | `TRUST_PROXY=1` missing from `.env` |
| Sign-in works but every page is empty | old build: the session cookie was dropped over plain HTTP. `git pull` and rebuild |
| Exchange rate stuck at 1.08 | the server cannot reach `ecb.europa.eu`; set the rate by hand under Settings |
