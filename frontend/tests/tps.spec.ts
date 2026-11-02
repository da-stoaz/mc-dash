import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page, state: string, status = 'running', populated = false) {
  const server = { id: 'tps-test', name: 'TPS test', status, serverPort: 25565,
    resources: { minRamMb: 1024, maxRamMb: 2048 }, game: {} };
  await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ json: body });
    if (path.endsWith('/auth/me')) return json({ authenticated: true, authRequired: false });
    if (path.endsWith('/stream')) {
      let body = `event: server\ndata: ${JSON.stringify(server)}\n\n`;
      if (populated) {
        const sample = { status: 'running', at: Date.now(), cpuPercent: 24, cpuCores: 0.96, cpuCoresAvailable: 4,
          memoryPercent: 62, memoryBytes: 1331439861, memoryLimitBytes: 2147483648, uptimeSeconds: 8560 };
        const recent = Array.from({ length: 13 }, (_, i) => ({ ...sample, at: sample.at - 65000 + i * 5000, cpuPercent: 25, cpuCores: 1, memoryPercent: 50, memoryBytes: 1024 ** 3 }));
        body += `event: metrics-history\ndata: ${JSON.stringify(recent)}\n\n`;
        body += `event: metrics\ndata: ${JSON.stringify(sample)}\n\n`;
        body += `event: players\ndata: ${JSON.stringify({ online: 3, max: 20, names: ['Alex', 'Steve', 'Builder'] })}\n\n`;
      }
      return route.fulfill({ contentType: 'text/event-stream', body });
    }
    if (path.endsWith('/tps')) return json({
      state, current: state === 'available' ? { tps: 18.75, source: 'spark', window: '5s' } : null,
      sampledAt: Date.now(), points: state === 'available' ? [{ t: Date.now() - 10000, tps: 20 }, { t: Date.now(), tps: 18.75 }] : [],
    });
    if (path.endsWith('/metrics/history')) return json({ points: populated ? [20_000, 10_000].map(age => ({ t: Date.now() - age, cpuAvg: 25, cpuMax: 50, memAvg: 50, memMax: 75, cpuCoresAvg: 1, cpuCoresMax: 2, memoryBytesAvg: 1024 ** 3, memoryBytesMax: 1.5 * 1024 ** 3 })) : [], resolution: 30 });
    if (path.endsWith('/storage')) return json({ filesBytes: 14.8 * 1024 ** 3, snapshotsBytes: 39.3 * 1024 ** 3, totalBytes: 54.1 * 1024 ** 3, checkedAt: Date.now() });
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
  await expect(page.getByRole('region', { name: 'Storage usage' })).toContainText('54.1 GiB');
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
  await expect(page.getByRole('region', { name: 'Storage usage' })).toContainText('54.1 GiB');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('overview-mobile.png'), fullPage: true });
});


test('resource tooltips include recorded cores and gigabytes in live and historical views', async ({ page }) => {
  await setup(page, 'available', 'running', true);
  const cpu = page.getByRole('slider', { name: /CPU usage history/ });
  await cpu.focus();
  await cpu.press('Home');
  await expect(page.getByRole('tooltip')).toContainText('CPU usage1 cores');
  await expect(cpu).toHaveAttribute('aria-valuetext', /1 cores/);
  const memory = page.getByRole('slider', { name: /Memory usage history/ });
  await memory.focus();
  await memory.press('Home');
  await expect(page.getByRole('tooltip')).toContainText('Memory usage1.00 GiB');
  await memory.press('End');
  await expect(page.getByRole('tooltip')).toContainText('Memory usage1.24 GiB');
  await page.getByRole('button', { name: '1h', exact: true }).click();
  await cpu.focus();
  await expect(page.getByRole('tooltip')).toContainText('Peak usage2 cores');
  await memory.focus();
  await expect(page.getByRole('tooltip')).toContainText('Peak usage1.50 GiB');
});

test('Settings opens the organized server settings', async ({ page }) => {
  await setup(page, 'available', 'running', true);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Server settings', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Server name', exact: true })).toHaveValue('TPS test');
});

test('storage stays accessible offline, retains its last reading on failure, and can retry', async ({ page }) => {
  await setup(page, 'stopped', 'stopped');
  const storage = page.getByRole('region', { name: 'Storage usage' });
  await expect(storage).toContainText('54.1 GiB');
  await expect(storage).toContainText('14.8 GiB');
  await expect(storage).toContainText('39.3 GiB');
  await page.route('**/servers/tps-test/storage', route => route.fulfill({ status: 500, json: {} }));
  await storage.getByRole('button', { name: 'Refresh storage' }).click();
  await expect(storage.getByRole('status')).toContainText('Could not measure storage');
  await expect(storage).toContainText('54.1 GiB');
  await page.unroute('**/servers/tps-test/storage');
  await storage.getByRole('button', { name: 'Refresh storage' }).click();
  await expect(storage.getByRole('status')).toHaveCount(0);
  await expect(storage).toHaveAttribute('aria-busy', 'false');
  await page.getByText('Process diagnostics', { exact: true }).click();
  await expect(page.getByText('Available while the server is running.')).toBeVisible();
  await expect(page.getByText('Network transfer', { exact: true })).toHaveCount(0);
});

for (const status of ['verified', 'mismatch', 'unverified'] as const) {
  test(`runtime memory inspection is explicit and reports ${status}`, async ({ page }) => {
    let checks = 0;
    await setup(page, 'available', 'running', true);
    await page.route('**/servers/tps-test/memory-runtime', route => {
      checks++;
      return route.fulfill({ json: {status, initialHeapMb:512, maximumHeapMb:2048,
        containerLimitMb:2560, checkedAt:Date.now(), reason:'Runtime inspection result.'} });
    });
    expect(checks).toBe(0);
    await page.getByText('Check running memory settings', {exact:true}).click();
    expect(checks).toBe(0);
    await page.getByRole('button', {name:'Check settings',exact:true}).click();
    await expect(page.getByText(status === 'verified' ? 'Heap settings match' : status === 'mismatch' ? 'Settings differ' : 'Heap could not be verified',{exact:true})).toBeVisible();
    await expect(page.getByText('Runtime inspection result.',{exact:true})).toBeVisible();
    expect(checks).toBe(1);
  });
}
