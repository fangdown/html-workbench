import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

try {
  writeFileSync(new URL('../.env', import.meta.url), [
    'HOST=127.0.0.1',
    'PORT=3200',
    'DATA_DIR=./data',
    `APP_KEY=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env。模型配置保存在各自浏览器，服务器仅保存历史记录。');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env 已存在，保留现有配置。');
  else throw error;
}
