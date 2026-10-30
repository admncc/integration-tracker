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
