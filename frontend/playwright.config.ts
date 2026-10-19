import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3109', trace: 'retain-on-failure' },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3109',
    url: 'http://127.0.0.1:3109',
    env: { NEXT_PUBLIC_API_BASE_URL: '/api' },
    timeout: 120000,
  },
});
