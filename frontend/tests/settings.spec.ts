import { test, expect, type Page } from '@playwright/test';
import type { ServerRecord } from '../src/lib/serverTypes';

async function setup(page: Page, options: { running?: boolean; hardcore?: boolean; failSave?: boolean } = {}) {
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
    if (path === '/servers/settings-test') {
      if (request.method() === 'PATCH') {
        const patch = request.postDataJSON();
        patches.push(patch);
        if (options.failSave && patches.length === 1) return route.fulfill({ status: 409, json: { error: 'Not enough memory' } });
        // Match the backend: nested game/resources objects are replacements.
        server = { ...server, ...patch, restartRequired: Boolean(patch.game || patch.resources) };
      }
      if (request.method() === 'DELETE') actions.push('delete');
      return route.fulfill({ json: server });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/servers/settings-test');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Server settings', exact: true })).toBeVisible();
  return { patches, actions, errors };
}

for (const mobile of [false, true]) {
  test(`settings journeys fit ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, testInfo) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 });
    const { errors } = await setup(page);
    for (const name of ['General', 'Gameplay', 'Resources', 'Player access', 'Server pack']) {
      const tab = page.getByRole('tab', { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1440);
      await page.getByRole('region', { name: 'Server settings', exact: true }).screenshot({ path: testInfo.outputPath(`${name.toLowerCase().replaceAll(' ', '-')}.png`), animations: 'disabled', style: '[role="alert"] { visibility: hidden; }' });
    }
    expect(errors).toEqual([]);
  });
}

test('rename saves only the name and keeps edits across categories', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByLabel('Server name', { exact: true }).fill('A new name');
  await page.getByRole('tab', { name: 'Resources', exact: true }).click();
  await page.getByLabel('Maximum RAM (MB)', { exact: true }).fill('10000');
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await expect(page.getByLabel('Server name', { exact: true })).toHaveValue('A new name');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ name: 'A new name' });
  await expect(page.getByText('Saved. Changes will apply the next time the server starts.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Resources', exact: true }).click();
  await expect(page.getByLabel('Maximum RAM (MB)', { exact: true })).toHaveValue('10000');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByLabel('Maximum RAM (MB)', { exact: true })).toHaveValue('8192');
});

test('failed save keeps the draft and allows retry; CPU cap can be removed', async ({ page }) => {
  const { patches } = await setup(page, { failSave: true });
  await page.getByRole('tab', { name: 'Resources', exact: true }).click();
  await page.getByLabel('Maximum RAM (MB)', { exact: true }).fill('9000');
  await page.getByLabel('CPU limit (cores)', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Not enough memory' })).toBeVisible();
  await expect(page.getByLabel('Maximum RAM (MB)', { exact: true })).toHaveValue('9000');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toEqual({ resources: { minRamMb: 4096, maxRamMb: 9000 } });
  await expect(page.getByText('Saved. Restart the server to apply these changes.', { exact: true })).toBeVisible();
});

test('RAM range is validated before a request is sent', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByRole('tab', { name: 'Resources', exact: true }).click();
  await page.getByLabel('Minimum RAM (MB)', { exact: true }).fill('10000');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  expect(patches).toEqual([]);
  expect(await page.getByLabel('Minimum RAM (MB)', { exact: true }).evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await page.getByLabel('Minimum RAM (MB)', { exact: true }).fill('5000');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
});

test('changing gameplay preserves the rest of the world configuration', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByRole('tab', { name: 'Gameplay', exact: true }).click();
  await page.getByLabel('Game mode', { exact: true }).click();
  await page.getByRole('option', { name: 'Creative', exact: true }).click();
  await expect(page.getByLabel('World seed', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ game: { gameMode: 'creative', difficulty: 'normal', renderDistance: 12, entityBroadcastRangePercentage: 100, seed: '12345' } });
});

test('hardcore and running-server restrictions are visible', async ({ page }) => {
  await setup(page, { running: true, hardcore: true });
  await expect(page.getByLabel('Server port', { exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Gameplay', exact: true }).click();
  await expect(page.getByLabel('Difficulty', { exact: true })).toBeDisabled();
  await expect(page.getByText('Hardcore worlds are locked to Hard.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Server pack', exact: true }).click();
  await expect(page.getByLabel('Server pack ZIP', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Java runtime', { exact: true })).toBeDisabled();
});

test('access lists are retained when disabled and only changed access settings are sent', async ({ page }) => {
  const { patches } = await setup(page);
  await page.getByRole('tab', { name: 'Player access', exact: true }).click();
  await page.getByRole('switch', { name: 'Block specific players', exact: true }).click();
  await expect(page.getByLabel('Blocked players', { exact: true })).toHaveValue('Griefer');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ blacklistEnabled: false });
});

test('pack replacement leads directly to preparation', async ({ page }) => {
  const { actions } = await setup(page);
  await page.getByRole('tab', { name: 'Server pack', exact: true }).click();
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
  await page.getByRole('tab', { name: 'Server pack', exact: true }).click();
  const runtime = page.getByLabel('Java runtime', { exact: true });
  await runtime.click();
  await expect(runtime).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('option', { name: 'Custom image…', exact: true }).click();
  await page.getByLabel('Custom Java image', { exact: true }).fill('my-java:21');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(runtime).toContainText('Java 17');
  await expect(page.getByLabel('Custom Java image', { exact: true })).toHaveCount(0);
  await runtime.click();
  await page.getByRole('option', { name: 'Auto-detect from server pack', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ javaImage: null });
});

test('settings categories support keyboard navigation', async ({ page }) => {
  await setup(page);
  await page.getByRole('tab', { name: 'General', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Gameplay', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Gameplay', exact: true })).toBeVisible();
});
