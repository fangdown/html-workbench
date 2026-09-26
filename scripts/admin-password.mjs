import { randomBytes, scryptSync } from 'node:crypto';

const password = process.env.ADMIN_PASSWORD ?? '';
if (password.length < 8 || password.length > 200) {
  throw new Error('请通过 ADMIN_PASSWORD 环境变量提供 8-200 个字符的管理员密码。');
}
const salt = randomBytes(16);
const digest = scryptSync(password, salt, 32);
console.log(`ADMIN_PASSWORD_HASH=scrypt:${salt.toString('base64url')}:${digest.toString('base64url')}`);
