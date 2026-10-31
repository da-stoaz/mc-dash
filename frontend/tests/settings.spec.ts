import { test, expect, type Page } from '@playwright/test';
import type { ServerRecord } from '../src/lib/serverTypes';

async function setup(page: Page, options: { running?: boolean; hardcore?: boolean; failSave?: boolean; backgroundSave?: 'success' | 'failure'; entry?: string } = {}) {
  let server: ServerRecord = {
    id: 'settings-test', name: 'Sunday survival', subdomain: 'sunday', serverPort: 25567,
    status: options.running ? 'running' : 'stopped', containerId: 'test-container-123',
    resources: { minRamMb: 4096, maxRamMb: 8192, cpuLimit: 2 },
    game: { gameMode: 'survival', difficulty: options.hardcore ? 'hard' : 'normal', renderDistance: 12, entityBroadcastRangePercentage: 100, seed: '12345' },
    whitelistEnabled: false, whitelist: ['Alex'], blacklistEnabled: true, blacklist: ['Griefer'],
    javaImage: 'eclipse-temurin:17-jre', effectiveJavaImage: 'eclipse-temurin:17-jre',
    serverPackUrl: '/packs/serverpack.zip', serverPackName: 'Better Minecraft v9.2.zip', packReady: true,
  };
  const patches: Record<string, unknown>[] = [];
  const actions: string[] = [];
  const errors: string[] = [];
  let pendingServer: ServerRecord | undefined;
  let polls = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/(?:localhost:4000\/|\/api\/)/, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    if (path === '/auth/me') return route.fulfill({ json: { authenticated: true, authRequired: false } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `event: server\ndata: ${JSON.stringify(server)}\n\n` });
    if (path.endsWith('/metrics/history')) return route.fulfill({ json: { points: [] } });
    if (path.endsWith('/difficulty')) return route.fulfill({ json: {
      current: server.game.difficulty, available: options.hardcore ? ['hard'] : ['peaceful', 'easy', 'normal', 'hard'],
      locked: Boolean(options.hardcore), lockedReason: options.hardcore ? 'Hardcore worlds are locked to Hard.' : undefined,
    } });
    if (path === '/servers/uploads') return route.fulfill({ json: { id: 'test-upload', chunkSize: 1024 } });
    if (path.startsWith('/servers/uploads/')) return route.fulfill({ json: { ok: true } });
    if (path.endsWith('/pack')) {
      actions.push('pack');
      server = { ...server, serverPackName: 'new-pack.zip', packReady: false };
      return route.fulfill({ json: server });
    }
    if (path.endsWith('/prepare')) {
      actions.push('prepare'); server = { ...server, packReady: true };
      return route.fulfill({ json: server });
    }
    if (path === '/servers/settings-test/operations/settings-save') {
      if (++polls === 1) return route.fulfill({ json: { status: 'running' } });
      if (options.backgroundSave === 'failure') return route.fulfill({ json: {
        status: 'failed', httpStatus: 409, body: { error: 'Not enough memory' },
      } });
      server = pendingServer!;
      return route.fulfill({ json: { status: 'completed', httpStatus: 200, body: server } });
    }
    if (path === '/servers/settings-test') {
      if (request.method() === 'PATCH') {
        const patch = request.postDataJSON();
        patches.push(patch);
        if (options.failSave && patches.length === 1) return route.fulfill({ status: 409, json: { error: 'Not enough memory' } });
        // Match the backend: nested game/resources objects are replacements.
        const updated = { ...server, ...patch, restartRequired: Boolean(patch.game || patch.resources) };
        if (options.backgroundSave) {
          expect(request.headers().prefer).toBe('respond-async');
          pendingServer = updated;
          return route.fulfill({ status: 202, json: {
            operationId: 'settings-save', statusUrl: '/servers/settings-test/operations/settings-save',
          } });
        }
        server = updated;
      }
      if (request.method() === 'DELETE') actions.push('delete');
      return route.fulfill({ json: server });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(options.entry ?? '/servers/settings-test');
  if (!options.entry) await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Server settings', exact: true })).toBeVisible();
  return { patches, actions, errors };
}

for (const mobile of [false, true]) {
  test(`all settings are visible together on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, testInfo) => {
    const width = mobile ? 390 : 1440;
    await page.setViewportSize({ width, height: mobile ? 844 : 1100 });
    const { errors } = await setup(page);
    await expect(page.getByRole('tablist', { name: 'Settings categories' })).toHaveCount(0);
    for (const name of ['General', 'Gameplay', 'Resources', 'Player access', 'Server pack']) {
      const group = page.getByRole('region', { name, exact: true });
      await expect(group.getByRole('heading', { name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true, animations: 'disabled', style: '[role="alert"] { visibility: hidden; }' });
    expect(errors).toEqual([]);
  });
}

test('rename saves only the name and keeps edits across categories', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByLabel('Server name', { exact: true }).fill('A new name');
  await page.getByLabel('RAM limit (MiB)', { exact: true }).fill('10000');
  await expect(page.getByLabel('Server name', { exact: true })).toHaveValue('A new name');
  await page.getByRole('region', { name: 'General', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ name: 'A new name' });
  await expect(page.getByText('Saved. Changes will apply the next time the server starts.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('RAM limit (MiB)', { exact: true })).toHaveValue('10000');
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByLabel('RAM limit (MiB)', { exact: true })).toHaveValue('8192');
});

test('failed save keeps the draft and allows retry; CPU cap can be removed', async ({ page }) => {
  const { patches } = await setup(page, { failSave: true });
  await page.getByLabel('RAM limit (MiB)', { exact: true }).fill('9000');
  await page.getByLabel('CPU limit (cores)', { exact: true }).fill('');
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Not enough memory' })).toBeVisible();
  await expect(page.getByLabel('RAM limit (MiB)', { exact: true })).toHaveValue('9000');
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toEqual({ resources: { minRamMb: 4096, maxRamMb: 9000 } });
  await expect(page.getByText('Saved. Restart the server to apply these changes.', { exact: true })).toBeVisible();
});

test('RAM range is validated before a request is sent', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByLabel('Initial Java heap (MiB)', { exact: true }).fill('10000');
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  expect(patches).toEqual([]);
  expect(await page.getByLabel('Initial Java heap (MiB)', { exact: true }).evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await page.getByLabel('Initial Java heap (MiB)', { exact: true }).fill('5000');
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
});

test('RAM limit enforces the backend minimum before saving', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByLabel('Initial Java heap (MiB)', { exact: true }).fill('256');
  const limit = page.getByLabel('RAM limit (MiB)', { exact: true });
  await limit.fill('511');
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  expect(patches).toEqual([]);
  expect(await limit.evaluate((input: HTMLInputElement) => input.validity.rangeUnderflow)).toBe(true);
  await limit.fill('512');
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ resources: { minRamMb: 256, maxRamMb: 512, cpuLimit: 2 } });
});

for (const outcome of ['success', 'failure'] as const) {
  test(`settings save waits for background ${outcome}`, async ({ page }) => {
    const { patches } = await setup(page, { backgroundSave: outcome });
      await page.getByLabel('RAM limit (MiB)', { exact: true }).fill('9000');
    await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
    await expect(page.getByLabel('RAM limit (MiB)', { exact: true })).toBeDisabled();
    if (outcome === 'success') {
      await expect(page.getByText('Saved. Restart the server to apply these changes.', { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    } else {
      await expect(page.getByRole('alert').filter({ hasText: 'Not enough memory' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
    }
    await expect(page.getByLabel('RAM limit (MiB)', { exact: true })).toHaveValue('9000');
    expect(patches).toHaveLength(1);
  });
}

test('saving a RAM edit preserves untouched resource changes from live updates', async ({ page }) => {
  await page.addInitScript(() => {
    class DetailEvents extends EventTarget {
      constructor() {
        super();
        Object.assign(window, { detailEvents: this });
        setTimeout(() => this.dispatchEvent(new MessageEvent('server', { data: JSON.stringify({
          id: 'settings-test', name: 'Sunday survival', status: 'stopped', serverPort: 25567,
          resources: { minRamMb: 4096, maxRamMb: 8192, cpuLimit: 2 }, game: {},
        }) })), 0);
      }
      close() {}
    }
    Object.assign(window, { EventSource: DetailEvents });
  });
  const { patches } = await setup(page);
  await page.getByLabel('RAM limit (MiB)', { exact: true }).fill('9000');
  await page.evaluate(server => {
    (window as unknown as { detailEvents: EventTarget }).detailEvents.dispatchEvent(new MessageEvent('server', { data: JSON.stringify(server) }));
  }, {
    id: 'settings-test', name: 'Sunday survival', status: 'stopped', serverPort: 25567,
    resources: { minRamMb: 2048, maxRamMb: 8192, cpuLimit: 4 }, game: {},
  });
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ resources: { minRamMb: 2048, maxRamMb: 9000, cpuLimit: 4 } });
});

test('changing gameplay preserves the rest of the world configuration', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByLabel('Game mode', { exact: true }).click();
  await page.getByRole('option', { name: 'Creative', exact: true }).click();
  await expect(page.getByLabel('World seed', { exact: true })).toBeDisabled();
  await page.getByRole('region', { name: 'Gameplay', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ game: { gameMode: 'creative', difficulty: 'normal', renderDistance: 12, entityBroadcastRangePercentage: 100, seed: '12345' } });
});

test('hardcore and running-server restrictions are visible', async ({ page }) => {
  await setup(page, { running: true, hardcore: true });
  await expect(page.getByLabel('Server port', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Difficulty', { exact: true })).toBeDisabled();
  await expect(page.getByText('Hardcore worlds are locked to Hard.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Server pack ZIP', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Java runtime', { exact: true })).toBeDisabled();
});

test('access lists are retained when disabled and only changed access settings are sent', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByRole('switch', { name: 'Block specific players', exact: true }).click();
  await expect(page.getByLabel('Blocked players', { exact: true })).toHaveValue('Griefer');
  await page.getByRole('region', { name: 'Player access', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ blacklistEnabled: false });
});

test('pack replacement leads directly to preparation', async ({ page }) => {
  const { actions } = await setup(page);
  await page.getByLabel('Server pack ZIP', { exact: true }).setInputFiles({ name: 'new-pack.zip', mimeType: 'application/zip', buffer: Buffer.from('test zip') });
  await page.getByRole('button', { name: 'Upload pack', exact: true }).click();
  await expect(page.getByText('new-pack.zip', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare server', exact: true }).click();
  await expect.poll(() => actions).toEqual(['pack', 'prepare']);
  await expect(page.getByRole('button', { name: 'Prepare server', exact: true })).toHaveCount(0);
});

test('deletion still requires confirmation', async ({ page }) => {
  const { actions } = await setup(page);
  await page.getByRole('button', { name: 'Delete server', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(actions).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(actions).toEqual([]);
});

test('Java runtime supports custom images, discard, and auto-detection', async ({ page }) => {
  const { patches } = await setup(page);
  const runtime = page.getByRole('button', { name: 'Java runtime', exact: true });
  await runtime.click();
  await expect(runtime).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('option', { name: 'Custom image…', exact: true }).click();
  await page.getByLabel('Custom Java image', { exact: true }).fill('my-java:21');
  await page.getByRole('region', { name: 'Server pack', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(runtime).toContainText('Java 17');
  await expect(page.getByLabel('Custom Java image', { exact: true })).toHaveCount(0);
  await runtime.click();
  await page.getByRole('option', { name: 'Auto-detect from server pack', exact: true }).click();
  await page.getByRole('region', { name: 'Server pack', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ javaImage: null });
});

test('jump links move to visible settings groups with the keyboard', async ({ page }) => {
  await setup(page);
  const link = page.getByRole('navigation', { name: 'Jump to settings' }).getByRole('link', { name: 'Gameplay', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Gameplay', exact: true })).toBeFocused();
  await expect(page).toHaveURL(/tab=settings#settings-gameplay$/);
  await expect(page.getByLabel('Server name', { exact: true })).toBeVisible();
});

test('browser Back and reload restore the selected section; tab switches keep drafts', async ({ page }) => {
  await setup(page);
  await expect(page).toHaveURL(/tab=settings$/);
  await page.getByLabel('Server name', { exact: true }).fill('Unsaved name');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Resource usage' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Server name', { exact: true })).toHaveValue('Unsaved name');
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Server name', { exact: true })).toHaveValue('Sunday survival');
});

test('a direct link opens Settings at the requested group', async ({ page }) => {
  await setup(page, { entry: '/servers/settings-test?tab=settings#settings-pack' });
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Server pack', exact: true })).toBeInViewport();
});
