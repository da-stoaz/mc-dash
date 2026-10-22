import { test, expect } from '@playwright/test';

for (const state of ['enforced', 'unverified', 'pressure', 'disabled', 'countdown', 'save-failed'] as const) {
  test(`shared RAM summary: ${state}`, async ({ page }, testInfo) => {
    await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { authenticated: true, authRequired: false } });
      if (path.endsWith('/host/capacity')) return route.fulfill({ json: { servers: [{live:true,actualMb:6000}], pool: {
        enabled: state !== 'disabled', enforced: ['enforced', 'pressure', 'countdown', 'save-failed'].includes(state),
        usedMb: state === 'pressure' ? 11000 : 6000, limitMb: 12288,
        lastAction: state === 'countdown' ? 'Survival will save and sleep in 30s to release RAM.' : state === 'save-failed' ? 'Could not safely sleep Survival. No forced stop was sent. Check its console.' : null,
        pressure: ['pressure', 'countdown', 'save-failed'].includes(state), reason: state === 'unverified' ? 'MC Dash must run outside the Minecraft memory pool.' : null,
      } } });
      if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: servers\ndata: []\n\n' });
      if (path.endsWith('/servers')) return route.fulfill({ json: [] });
      return route.fulfill({ json: {} });
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Minecraft RAM' })).toBeVisible();
    await expect(page.getByText('Capacity details')).toHaveCount(0);
    const meter = page.getByRole('meter', { name: 'Minecraft shared RAM usage' });
    if (state === 'enforced') await expect(page.getByText('Shared by Minecraft servers. MC Dash runs outside this limit.', { exact: true })).toBeVisible();
    if (['enforced', 'pressure', 'countdown', 'save-failed'].includes(state)) {
      await expect(meter).toBeVisible();
      await expect(page.getByText('/ 12.0 GB limit', { exact: true })).toBeVisible();
    } else {
      await expect(meter).toHaveCount(0);
      await expect(page.getByText(state === 'disabled' ? 'Monitoring only. The shared RAM limit is not enforced on this host.' : 'MC Dash must run outside the Minecraft memory pool.', { exact: true })).toBeVisible();
    }
    if (state === 'disabled') await expect(page.getByText('5.9 GB used', { exact: true })).toBeVisible();
    if (state === 'countdown') await expect(page.getByText('Survival will save and sleep in 30s to release RAM.', { exact: true })).toBeVisible();
    if (state === 'save-failed') await expect(page.getByText(/Could not safely sleep Survival/)).toBeVisible();
    if (state === 'pressure') await expect(page.getByText(/RAM is high/)).toBeVisible();
    if (state === 'enforced') {
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.screenshot({ path: testInfo.outputPath('shared-ram-mobile.png'), fullPage: true });
    }
  });
}
