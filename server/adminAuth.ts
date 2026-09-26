import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'ai_zhili_admin';
const SESSION_SECONDS = 24 * 60 * 60;

function parsePasswordHash(value: string) {
  const [scheme, saltValue, digestValue] = value.split(':');
  if (scheme !== 'scrypt' || !saltValue || !digestValue) throw new Error('ADMIN_PASSWORD_HASH 格式无效。');
  const salt = Buffer.from(saltValue, 'base64url');
  const digest = Buffer.from(digestValue, 'base64url');
  if (salt.length < 16 || digest.length !== 32) throw new Error('ADMIN_PASSWORD_HASH 格式无效。');
  return { salt, digest };
}

function safeEqual(actual: Buffer, expected: Buffer) {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashAdminPassword(password: string, salt = randomBytes(16)) {
  if (password.length < 8 || password.length > 200) throw new Error('管理员密码长度需为 8-200 个字符。');
  const digest = scryptSync(password, salt, 32);
  return ['scrypt', salt.toString('base64url'), digest.toString('base64url')].join(':');
}

export function createAdminAuth(options: {
  passwordHash?: string;
  sessionSecret?: string;
  secure?: boolean;
  now?: () => number;
}) {
  const passwordHash = options.passwordHash?.trim() ?? '';
  const configured = Boolean(passwordHash);
  const parsedHash = configured ? parsePasswordHash(passwordHash) : null;
  if (configured && !/^[a-f\d]{64}$/i.test(options.sessionSecret ?? '')) {
    throw new Error('启用管理员功能时必须配置 64 位十六进制 APP_KEY。');
  }
  const secret = configured ? Buffer.from(options.sessionSecret!, 'hex') : Buffer.alloc(0);
  const now = options.now ?? Date.now;
  const secure = options.secure ?? false;
  const signature = (payload: string) => createHmac('sha256', secret).update(`admin:${payload}`).digest();

  return {
    configured,
    verifyPassword(password: string) {
      if (!parsedHash || password.length > 200) return false;
      return safeEqual(scryptSync(password, parsedHash.salt, parsedHash.digest.length), parsedHash.digest);
    },
    createSessionCookie() {
      if (!configured) throw new Error('管理员功能未配置。');
      const expires = Math.floor(now() / 1000) + SESSION_SECONDS;
      const payload = `${expires}.${randomBytes(16).toString('base64url')}`;
      const token = `${payload}.${signature(payload).toString('base64url')}`;
      return [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_SECONDS}`, secure ? 'Secure' : ''].filter(Boolean).join('; ');
    },
    clearSessionCookie() {
      return [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT', secure ? 'Secure' : ''].filter(Boolean).join('; ');
    },
    isAuthenticated(cookieHeader: string | undefined) {
      if (!configured || !cookieHeader) return false;
      const raw = cookieHeader.split(';').map(item => item.trim()).find(item => item.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);
      if (!raw) return false;
      const [expiresValue, nonce, signatureValue] = raw.split('.');
      const expires = Number(expiresValue);
      if (!Number.isSafeInteger(expires) || expires <= Math.floor(now() / 1000) || !nonce || !signatureValue) return false;
      const payload = `${expiresValue}.${nonce}`;
      return safeEqual(Buffer.from(signatureValue, 'base64url'), signature(payload));
    },
  };
}
