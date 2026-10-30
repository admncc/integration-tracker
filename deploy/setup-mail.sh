#!/usr/bin/env bash
#
# Send-only e-mail for the Integration Tracker, on the same server:
# Postfix listening on 127.0.0.1 only, every message DKIM-signed by OpenDKIM.
# Nothing is received and nothing is reachable from outside.
#
#   sudo bash deploy/setup-mail.sh example.com
#
# Safe to run again: the DKIM key is kept, the configuration rewritten. At the
# end it prints the DNS records to add and the lines for .env.
#
set -euo pipefail

DOMAIN="${1:-}"
SELECTOR="${2:-tracker}"
if [[ -z "$DOMAIN" || "$DOMAIN" == -* ]]; then
  echo "usage: sudo bash deploy/setup-mail.sh <domain the mail comes from> [dkim selector]" >&2
  exit 1
fi
if [[ "$(id -u)" != 0 ]]; then
  echo "Run it with sudo." >&2
  exit 1
fi

HOSTNAME_FQDN="mail.${DOMAIN}"
KEY_DIR="/etc/opendkim/keys/${DOMAIN}"
PUBLIC_IP="$( { ip -4 route get 1.1.1.1 2>/dev/null || true; } | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="$( { hostname -I 2>/dev/null || true; } | awk '{print $1}')"

echo "== Installing Postfix and OpenDKIM"
export DEBIAN_FRONTEND=noninteractive
echo "postfix postfix/main_mailer_type string 'Internet Site'" | debconf-set-selections
echo "postfix postfix/mailname string ${DOMAIN}" | debconf-set-selections
apt-get install -y -qq postfix opendkim opendkim-tools >/dev/null

echo "== Postfix: send only, loopback only"
echo "${DOMAIN}" > /etc/mailname
postconf -e \
  "myhostname = ${HOSTNAME_FQDN}" \
  "mydomain = ${DOMAIN}" \
  "myorigin = /etc/mailname" \
  "inet_interfaces = loopback-only" \
  "mydestination = localhost" \
  "relayhost =" \
  "smtp_tls_security_level = may" \
  "smtpd_milters = inet:127.0.0.1:8891" \
  "non_smtpd_milters = inet:127.0.0.1:8891" \
  "milter_default_action = accept"
# IPv4 only: Gmail and others refuse mail over IPv6 from an address without
# reverse DNS, and a fresh server's IPv6 has none.
postconf -e "inet_protocols = ipv4"

echo "== OpenDKIM key (${SELECTOR}._domainkey.${DOMAIN})"
install -d -o opendkim -g opendkim -m 750 "${KEY_DIR}"
if [[ ! -f "${KEY_DIR}/${SELECTOR}.private" ]]; then
  opendkim-genkey -b 2048 -h rsa-sha256 -r -s "${SELECTOR}" -d "${DOMAIN}" -D "${KEY_DIR}"
  echo "   new key created"
else
  echo "   existing key kept"
fi
chown -R opendkim:opendkim "${KEY_DIR}"
chmod 600 "${KEY_DIR}/${SELECTOR}.private"

[[ -f /etc/opendkim.conf.orig ]] || cp /etc/opendkim.conf /etc/opendkim.conf.orig
cat > /etc/opendkim.conf <<EOF
# Written by deploy/setup-mail.sh - the distribution's original is in opendkim.conf.orig.
Syslog            yes
SyslogSuccess     yes
UserID            opendkim
UMask             007
PidFile           /run/opendkim/opendkim.pid
Mode              s
Canonicalization  relaxed/simple
OversignHeaders   From
Domain            ${DOMAIN}
Selector          ${SELECTOR}
KeyFile           ${KEY_DIR}/${SELECTOR}.private
Socket            inet:8891@127.0.0.1
EOF

echo "== Restarting"
systemctl enable --now opendkim >/dev/null 2>&1 || true
systemctl restart opendkim
systemctl restart postfix

echo "== Can this server reach other mail servers on port 25?"
if timeout 8 bash -c '</dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then
  PORT25="open"
  echo "   yes"
else
  PORT25="blocked"
  echo "   NO - outgoing port 25 is blocked. Hetzner blocks it on new cloud servers;"
  echo "   ask for it to be unblocked (Cloud Console -> Limits / support request),"
  echo "   or relay through a provider instead (SMTP_HOST/SMTP_USER/SMTP_PASS in .env)."
fi

DKIM_VALUE="$(tr -d '\n' < "${KEY_DIR}/${SELECTOR}.txt" | sed -E 's/^[^(]*\(//; s/\).*$//; s/"[[:space:]]*"//g; s/"//g; s/[[:space:]]+/ /g; s/^ //; s/ $//')"

cat <<EOF

=====================================================================
 DNS records to add for ${DOMAIN} (in Cloudflare: "DNS only", grey cloud)
=====================================================================

 Type  Name                          Content
 ----  ----------------------------  -----------------------------------------
 TXT   $(printf '%-28s' "${DOMAIN}")  v=spf1 ip4:${PUBLIC_IP:-<server IPv4>} ~all
 TXT   $(printf '%-28s' "${SELECTOR}._domainkey")  ${DKIM_VALUE}
 TXT   $(printf '%-28s' "_dmarc")  v=DMARC1; p=none

 SPF: if mail for ${DOMAIN} is also sent by something else (Google
 Workspace, Microsoft 365, a newsletter tool), add its include: to the same
 record instead of creating a second one.

 And at the hosting provider - not in DNS - the reverse DNS (PTR) of
 ${PUBLIC_IP:-the server IP}: ${HOSTNAME_FQDN}
 (Hetzner Cloud Console -> server -> Networking -> the IPv4 -> Edit Reverse DNS)
 plus an A record ${HOSTNAME_FQDN} -> ${PUBLIC_IP:-<server IPv4>} if there is none yet.

=====================================================================
 Lines for /opt/integration-tracker/.env
=====================================================================

SMTP_HOST=127.0.0.1
SMTP_PORT=25
MAIL_FROM="Integration Tracker <noreply@${DOMAIN}>"

 Then: sudo systemctl restart integration-tracker
 and Settings -> Sign-in e-mails -> "Send a test e-mail".

 Outgoing port 25: ${PORT25}
 Delivery log:     sudo journalctl -u postfix -f   (or /var/log/mail.log)
 DKIM check:       sudo opendkim-testkey -d ${DOMAIN} -s ${SELECTOR} -vvv
EOF
