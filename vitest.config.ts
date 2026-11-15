import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: './infra/wrangler.jsonc' },
    miniflare: { bindings: {
      TEST_MIGRATIONS: await readD1Migrations('./infra/migrations'),
    } },
  }))],
  test: { include: ['tests/integration/**/*.test.ts'], testTimeout: 30000 },
});
