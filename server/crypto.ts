import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function createVault(hexKey: string | undefined) {
  if (!hexKey || !/^[a-f\d]{64}$/i.test(hexKey)) {
    throw new Error('缺少有效 APP_KEY。请先执行 npm run setup，或配置 64 位十六进制加密密钥。');
  }
  const key = Buffer.from(hexKey, 'hex');
  return {
    encrypt(value: string) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const content = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [iv, cipher.getAuthTag(), content].map(part => part.toString('base64url')).join('.');
    },
    decrypt(value: string) {
      try {
        const [iv, tag, content] = value.split('.').map(part => Buffer.from(part, 'base64url'));
        if (!iv || !tag || !content) throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', key, iv);
        cipher.setAuthTag(tag);
        return Buffer.concat([cipher.update(content), cipher.final()]).toString('utf8');
      } catch {
        throw new Error('无法解密模型 Key，请检查 APP_KEY 是否与原配置一致。');
      }
    },
  };
}
