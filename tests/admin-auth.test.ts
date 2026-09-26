import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAdminAuth, hashAdminPassword } from '../server/adminAuth.ts';

test('管理员密码哈希和签名会话可验证且不可篡改', () => {
  const password = 'correct horse battery staple';
  const passwordHash = hashAdminPassword(password, Buffer.alloc(16, 7));
  const secret = '11'.repeat(32);
  const now = 1_800_000_000_000;
  const auth = createAdminAuth({ passwordHash, sessionSecret: secret, secure: true, now: () => now });
  assert.equal(auth.configured, true);
  assert.equal(auth.verifyPassword(password), true);
  assert.equal(auth.verifyPassword('wrong password'), false);
  const cookie = auth.createSessionCookie();
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  const cookieHeader = cookie.split(';')[0];
  assert.equal(auth.isAuthenticated(cookieHeader), true);
  assert.equal(auth.isAuthenticated(`${cookieHeader}x`), false);
  const expired = createAdminAuth({ passwordHash, sessionSecret: secret, now: () => now + 25 * 60 * 60 * 1000 });
  assert.equal(expired.isAuthenticated(cookieHeader), false);
});

test('未配置管理员密码时不会生成有效会话', () => {
  const auth = createAdminAuth({});
  assert.equal(auth.configured, false);
  assert.equal(auth.verifyPassword('anything'), false);
  assert.equal(auth.isAuthenticated('ai_zhili_admin=fake'), false);
  assert.throws(() => auth.createSessionCookie());
});
