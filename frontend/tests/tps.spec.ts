import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page, state: string, status = 'running', populated = false) {
  const server = { id: 'tps-test', name: 'TPS test', status, serverPort: 25565,
    resources: { minRamMb: 1024, maxRamMb: 2048 }, game: {} };
  await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith('/auth/me')) return json({ authenticated: true, authRequired: false });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `event: server\ndata: ${JSON.stringify(server)}\n\n` + (populated ? `event: metrics\ndata: ${JSON.stringify({ cpuPercent: 24, cpuCores: 0.96, cpuCoresAvailable: 4, memoryPercent: 62, memoryBytes: 1331439861, memoryLimitBytes: 2147483648, uptimeSeconds: 8560 })}\n\nevent: players\ndata: ${JSON.stringify({ online: 3, max: 20, names: ['Alex', 'Steve', 'Builder'] })}\n\n` : '') });
    if (path.endsWith('/tps')) return json({
      state, current: state === 'available' ? { tps: 18.75, source: 'spark', window: '5s' } : null,
      sampledAt: Date.now(), points: state === 'available' ? [{ t: Date.now() - 10000, tps: 20 }, { t: Date.now(), tps: 18.75 }] : [],
    });
    if (path.endsWith('/metrics/history')) return json({ points: [], resolution: 60 });
    if (path.endsWith('/tps-test')) return json(server);
    return json({});
  });
  await page.goto('/servers/tps-test');
}

test('tick rate stays visible while browsing resource history', async ({ page }, testInfo) => {
  await setup(page, 'available', 'running', true);
  const chart = page.getByRole('slider', { name: /TPS history/ });
  await expect(chart).toBeVisible();
  await expect(page.getByText('18.75 TPS', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Resource usage' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Server tick rate' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('overview-desktop.png'), fullPage: true });
  await chart.focus();
  await chart.press('ArrowLeft');
  await expect(chart).toHaveAttribute('aria-valuetext', /20.00 TPS/);
  await chart.press('ArrowRight');
  await expect(chart).toHaveAttribute('aria-valuetext', /18.75 TPS/);
  await page.getByRole('button', { name: '1h', exact: true }).click();
  await expect(chart).toBeVisible();
  await expect(page.getByRole('button', { name: '1h', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Live 60s', exact: true }).click();
  await expect(chart).toBeVisible();
});

test('confirmed unsupported commands hide the entire TPS card', async ({ page }) => {
  await setup(page, 'unsupported');
  await expect(page.getByText('TPS test', { exact: true })).toBeVisible();
  await expect(page.getByText('Server tick rate', { exact: true })).toHaveCount(0);
  await expect(page.getByText('TPS', { exact: true })).toHaveCount(0);
});

test('temporary unavailability keeps the TPS card visible', async ({ page }) => {
  await setup(page, 'unavailable');
  await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('TPS', { exact: true })).toBeVisible();
});

test('stopped servers do not poll TPS', async ({ page }) => {
  let calls = 0;
  page.on('request', req => { if (req.url().endsWith('/tps')) calls++; });
  await setup(page, 'stopped', 'stopped');
  await expect(page.getByText('CPU usage', { exact: true })).toBeVisible();
  await expect(page.getByText('TPS', { exact: true })).toHaveCount(0);
  expect(calls).toBe(0);
});


test('overview fits mobile and distinguishes missing readings from zero', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, 'available');
  await expect(page.getByText('Waiting for a reading', { exact: true })).toHaveCount(3);
  await expect(page.getByText('0%', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Connected players' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('overview-mobile.png'), fullPage: true });
});
