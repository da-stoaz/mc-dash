// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', workers: 1, timeout: 30000, use: { baseURL: 'http://localhost:3000' } });
