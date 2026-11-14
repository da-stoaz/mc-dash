// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from '@playwright/test';

// AGPL-3.0 section 13: users of the dashboard are offered its source.
test('dashboard footer links to the license and the source code', async ({ page }, testInfo) => {
  await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { authenticated: true, authRequired: false } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: servers\ndata: []\n\n' });
    if (path.endsWith('/servers')) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');

  const footer = page.getByRole('contentinfo');
  await expect(footer).toContainText('MC Dash is free software under the GNU AGPL v3');
  await expect(footer.getByRole('link', { name: 'GNU AGPL v3' })).toHaveAttribute('href', 'https://www.gnu.org/licenses/agpl-3.0.html');
  await expect(footer.getByRole('link', { name: 'Source code' })).toHaveAttribute('href', 'https://github.com/da-stoaz/mc-dash');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('source-notice-mobile.png'), fullPage: true });
});
