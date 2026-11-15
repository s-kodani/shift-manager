import {existsSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
if (existsSync('infra/.dev.vars')) {
  console.log('infra/.dev.vars already exists; preserved.');
} else {
  writeFileSync('infra/.dev.vars', `BETTER_AUTH_SECRET=${randomBytes(32).toString('base64url')}\nPOC_TOKEN=${randomBytes(32).toString('base64url')}\n`,{mode:0o600});
  console.log('Created ignored infra/.dev.vars (values not printed).');
}
