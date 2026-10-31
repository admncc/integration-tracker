import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A database of its own, set before db.js opens one.
const dir = mkdtempSync(join(tmpdir(), 'tracker-login-'));
process.env.DATABASE_PATH = join(dir, 'test.db');
process.env.UPLOAD_DIR = join(dir, 'uploads');
process.env.PUBLIC_URL = 'https://tracker.example.test/';

const { db } = await import('../server/lib/db.js');
const login = await import('../server/lib/login.js');

const userId = Number(
  db
    .prepare("INSERT INTO users (username, email, name, password_hash, role) VALUES ('omerp', 'omerp@primis.test', 'Omer Peleg', '', 'partner')")
    .run().lastInsertRowid
);

test.after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a link works once', () => {
  const { token } = login.issueLoginToken(userId);
  assert.equal(login.redeemLink(token), userId);
  assert.equal(login.redeemLink(token), null);
});

test('the code works once, and spends the link sent with it', () => {
  const { token, code } = login.issueLoginToken(userId);
  assert.equal(login.redeemCode(userId, code), true);
  assert.equal(login.redeemCode(userId, code), false);
  assert.equal(login.redeemLink(token), null);
});

test('the code may be typed with the space it is printed with', () => {
  const { code } = login.issueLoginToken(userId);
  assert.equal(login.redeemCode(userId, `${code.slice(0, 3)} ${code.slice(3)}`), true);
});

test('an expired link or code is refused', () => {
  const { token, code } = login.issueLoginToken(userId);
  db.prepare("UPDATE login_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL").run();
  assert.equal(login.redeemLink(token), null);
  assert.equal(login.redeemCode(userId, code), false);
});

test('five wrong codes kill the right one', () => {
  const { code } = login.issueLoginToken(userId);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < login.MAX_CODE_ATTEMPTS; i += 1) assert.equal(login.redeemCode(userId, wrong), false);
  assert.equal(login.redeemCode(userId, code), false);
});

test('only hashes are stored', () => {
  const { token, code } = login.issueLoginToken(userId);
  const row = db.prepare('SELECT token_hash, code_hash FROM login_tokens ORDER BY id DESC LIMIT 1').get();
  assert.notEqual(row.token_hash, token);
  assert.ok(!row.code_hash.includes(code));
});

test('a disabled account cannot use a link it was sent', () => {
  const { token } = login.issueLoginToken(userId);
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(userId);
  assert.equal(login.redeemLink(token), null);
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(userId);
});

test('the link points at PUBLIC_URL, without a doubled slash', () => {
  assert.equal(login.signInLink('abc'), 'https://tracker.example.test/login?token=abc');
});

test('the e-mail carries the code, the link and the first name', () => {
  const mail = login.signInMail({ name: 'Omer Peleg', code: '123456', link: 'https://x.test/login?token=t' });
  assert.equal(mail.subject, 'Your sign-in code: 123 456');
  assert.match(mail.text, /Hi Omer,/);
  assert.match(mail.text, /https:\/\/x\.test\/login\?token=t/);
  assert.match(mail.html, /123 456/);
});

test('without a public address the e-mail has only the code', () => {
  const mail = login.signInMail({ name: 'Omer', code: '123456', link: null });
  assert.doesNotMatch(mail.text, /https?:/);
  assert.match(mail.text, /123 456/);
});

test('three failures from one address block it for a day; a success clears the count', async () => {
  const lockout = await import('../server/lib/lockout.js');
  assert.equal(lockout.recordFailure('192.0.2.1', 'code'), null);
  assert.equal(lockout.recordFailure('192.0.2.1', 'code'), null);
  const block = lockout.recordFailure('192.0.2.1', 'link');
  assert.ok(block);
  const hours = (new Date(block.until) - Date.now()) / 3600e3;
  assert.ok(hours > 23.9 && hours <= 24);
  assert.ok(lockout.activeBlock('192.0.2.1'));
  assert.equal(lockout.activeBlock('192.0.2.2'), null);

  lockout.recordFailure('192.0.2.3', 'code');
  lockout.recordFailure('192.0.2.3', 'code');
  lockout.clearFailures('192.0.2.3');
  assert.equal(lockout.recordFailure('192.0.2.3', 'code'), null);

  assert.equal(lockout.unblock('192.0.2.1'), 1);
  assert.equal(lockout.activeBlock('192.0.2.1'), null);
});

test('the client address is read the same with or without the IPv4-in-IPv6 prefix', async () => {
  const { clientIp } = await import('../server/lib/lockout.js');
  assert.equal(clientIp({ ip: '::ffff:203.0.113.9' }), '203.0.113.9');
  assert.equal(clientIp({ ip: '2001:db8::1' }), '2001:db8::1');
});
