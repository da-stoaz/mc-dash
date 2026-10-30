import { test, expect, type Page } from '@playwright/test';
import { emptyLiveHistory, mergeLiveHistory } from '../src/components/server-details/metricsUtils';
import type { ServerMetrics } from '../src/lib/serverTypes';

const sample = (at: number) => ({ at, status: 'running', cpuPercent: 25, memoryPercent: 50,
  cpuCores: 1, cpuCoresAvailable: 4, memoryBytes: 1024 ** 3, memoryLimitBytes: 2 * 1024 ** 3,
} as ServerMetrics & { at: number });

test('rolling history retains one boundary sample, deduplicates reconnects, and expires', () => {
  const start = 1_000_000;
  const samples = Array.from({ length: 15 }, (_, i) => sample(start - 70_000 + i * 5000));
  let history = mergeLiveHistory(emptyLiveHistory(), samples, start);
  expect(history.timestamps).toHaveLength(14);
  expect(mergeLiveHistory(history, samples, start)).toEqual(history);
  for (let elapsed = 1000; elapsed <= 70_000; elapsed += 1000) {
    const now = start + elapsed;
    history = mergeLiveHistory(history, elapsed % 5000 === 0 ? [sample(now)] : [], now);
    expect(history.timestamps[0]).toBeLessThan(now - 60_000);
    expect(history.timestamps[1]).toBeGreaterThanOrEqual(now - 60_000);
  }
  expect(mergeLiveHistory(history, [], start + 131_000).timestamps).toEqual([]);
  expect(mergeLiveHistory(emptyLiveHistory(), [sample(start - 80_000), sample(start)], start).timestamps).toEqual([start]);
});

async function chartPage(page: Page) {
  const now = Date.now() + 1000;
  await page.clock.install({ time: now - 1000 });
  await page.clock.pauseAt(now);
  await page.addInitScript(() => {
    class DetailEvents extends EventTarget {
      constructor() { super(); Object.assign(window, { detailEvents: this }); }
      close() {}
    }
    Object.assign(window, { EventSource: DetailEvents });
  });
  let tpsCalls = 0;
  const server = { id: 'window-test', name: 'Live window', status: 'running', serverPort: 25565,
    resources: { minRamMb: 1024, maxRamMb: 2048 }, game: {} };
  await page.route(/(?:localhost:4000\/|\/api\/)/, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { authenticated: true, authRequired: false } });
    if (path.endsWith('/tps')) {
      tpsCalls++;
      const at = await page.evaluate(() => Date.now());
      return route.fulfill({ json: { state: 'available', current: { tps: 20, source: 'spark', window: '5s' }, sampledAt: at,
        points: Array.from({ length: 14 }, (_, i) => ({ t: at - 65000 + i * 5000, tps: 20 })) } });
    }
    if (path.endsWith('/window-test')) return route.fulfill({ json: server });
    if (path.endsWith('/storage')) return route.fulfill({ json: { filesBytes: 0, snapshotsBytes: 0, totalBytes: 0, checkedAt: now } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/servers/window-test');
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { detailEvents?: EventTarget }).detailEvents))).toBe(true);
  await emit(page, 'server', server);
  await expect(page.getByRole('heading', { name: 'Resource usage' })).toBeVisible();
  await expect(page.getByText('20.00 TPS', { exact: true })).toBeVisible();
  // React development mode may mount the polling effect twice initially.
  const initialCalls = tpsCalls;
  await emit(page, 'metrics-history', Array.from({ length: 14 }, (_, i) => sample(now - 65000 + i * 5000)));
  return { now, tpsCalls: () => tpsCalls - initialCalls };
}

async function emit(page: Page, name: string, payload: unknown) {
  await page.evaluate(({ name, payload }) => {
    (window as unknown as { detailEvents: EventTarget }).detailEvents.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(payload) }));
  }, { name, payload });
}

test('CPU, memory and TPS cover the left boundary as the full minute rolls forward', async ({ page }, testInfo) => {
  const { now } = await chartPage(page);
  for (let elapsed = 0; elapsed <= 70_000; elapsed += 5000) {
    if (elapsed) {
      await page.clock.runFor(3000);
      await emit(page, 'metrics', sample(now + elapsed));
    }
    await page.clock.runFor(2000);
    for (const label of ['CPU usage', 'Memory usage', 'TPS']) {
      const chart = page.getByRole('slider', { name: `${label} history. Use arrow keys to inspect samples.` });
      // A real point before x=0 and its successor after x=0 draw through the edge.
      const line = chart.locator('path[fill="none"]');
      await expect(line).toHaveAttribute('d', /^M -[\d.]+ [\d.]+ L [\d.]+ /);
      await expect(chart.locator('svg')).toHaveCSS('overflow', 'hidden');
    }
  }
  await page.screenshot({ path: testInfo.outputPath('rolling-window-desktop.png'), fullPage: true });
  // A collection outage stays a gap rather than extending the last value.
  await page.clock.runFor(20_000);
  await emit(page, 'metrics', sample(await page.evaluate(() => Date.now())));
  const cpu = page.getByRole('slider', { name: /CPU usage history/ });
  await expect(cpu.locator('path[fill="none"]')).toHaveAttribute('d', /L .* M /);
  await page.clock.runFor(61_000);
  await expect(cpu).toHaveCount(0);
});

test('TPS refreshes every five seconds', async ({ page }) => {
  const { tpsCalls } = await chartPage(page);
  await page.clock.runFor(4999);
  expect(tpsCalls()).toBe(0);
  await page.clock.runFor(1);
  await expect.poll(tpsCalls).toBe(1);
});

test('TPS stays still between readings and advances only when a real sample arrives', async ({ page }, testInfo) => {
  const { now } = await chartPage(page);
  const chart = page.getByRole('slider', { name: /TPS history/ });
  const line = chart.locator('path[fill="none"]');
  const initialPath = await line.getAttribute('d');
  expect(initialPath).toMatch(/L 100 0$/);

  await page.clock.runFor(4000);
  await expect(line).toHaveAttribute('d', initialPath!);

  let nextSample: number | null = null;
  let polls = 0;
  await page.route('**/servers/window-test/tps', async route => {
    polls++;
    const at = await page.evaluate(() => Date.now());
    return route.fulfill({ json: {
      state: nextSample === null ? 'unavailable' : 'available',
      current: nextSample === null ? null : { tps: 18, source: 'spark', window: '5s' },
      sampledAt: at,
      points: nextSample === null ? [{ t: at, tps: null }] : [
        ...Array.from({ length: 14 }, (_, i) => ({ t: now - 65000 + i * 5000, tps: 20 })),
        { t: nextSample, tps: 18 },
      ],
    } });
  });
  await page.clock.runFor(1000);
  await expect.poll(() => polls).toBe(1);
  await expect(page.getByText('Current reading unavailable; showing recent samples.')).toBeVisible();
  await expect(line).toHaveAttribute('d', initialPath!);
  await page.clock.runFor(10_000);
  await expect(line).toHaveAttribute('d', initialPath!);

  nextSample = now + 20_000;
  await page.clock.runFor(5000);
  await expect(page.getByText('18.00 TPS', { exact: true })).toBeVisible();
  await expect(line).not.toHaveAttribute('d', initialPath!);
  await expect(line).toHaveAttribute('d', /M 100 [\d.]+$/);
  await chart.press('End');
  await expect(chart).toHaveAttribute('aria-valuetext', /18.00 TPS/);
  await chart.blur();
  await page.screenshot({ path: testInfo.outputPath('tps-latest-sample.png'), fullPage: true });
  const updatedPath = await line.getAttribute('d');
  await page.clock.runFor(4000);
  await expect(line).toHaveAttribute('d', updatedPath!);
});
