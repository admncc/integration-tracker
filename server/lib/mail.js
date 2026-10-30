import nodemailer from 'nodemailer';

/**
 * Outgoing e-mail, over SMTP - a Postfix on the same machine
 * (deploy/setup-mail.sh) or any provider's relay. Configured in .env:
 *
 *   SMTP_HOST=127.0.0.1          required
 *   SMTP_PORT=25                 25 by default, 465 implies TLS from the start
 *   SMTP_SECURE=1                TLS from the start on another port
 *   SMTP_USER= / SMTP_PASS=      only for a relay that wants a login
 *   MAIL_FROM="Integration Tracker <noreply@example.com>"   required
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export class MailNotConfigured extends Error {
  constructor() {
    super('E-mail is not set up on this server (SMTP_HOST and MAIL_FROM in .env)');
  }
}

export function mailConfig() {
  const host = (process.env.SMTP_HOST ?? '').trim();
  const port = Number(process.env.SMTP_PORT || 25);
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === '1' || port === 465,
    user: process.env.SMTP_USER || '',
    from: (process.env.MAIL_FROM ?? '').trim(),
  };
}

export function mailConfigured() {
  const { host, from } = mailConfig();
  return Boolean(host && from);
}

let transport = null;
let transportKey = '';

function getTransport() {
  const config = mailConfig();
  const key = JSON.stringify(config);
  if (transport && key === transportKey) return transport;

  transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: process.env.SMTP_PASS ?? '' } : undefined,
    /*
     * On the same machine the message never crosses a network, and a local
     * Postfix offers STARTTLS with a self-signed certificate that would fail
     * verification. Plain SMTP over loopback is the normal setup there. Any
     * other host gets STARTTLS with full certificate checks.
     */
    ignoreTLS: LOOPBACK.has(config.host),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  transportKey = key;
  return transport;
}

/**
 * Sends one message. Without a configuration it throws in production; in
 * development it prints the message instead, so the sign-in still works on a
 * laptop with no mail server.
 */
export async function sendMail({ to, subject, text, html }) {
  if (!mailConfigured()) {
    if (process.env.NODE_ENV === 'production') throw new MailNotConfigured();
    console.log(`\n--- e-mail (not sent, SMTP not configured) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---\n`);
    return { logged: true };
  }
  const info = await getTransport().sendMail({ from: mailConfig().from, to, subject, text, html });
  return { messageId: info.messageId };
}
