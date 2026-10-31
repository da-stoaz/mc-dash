import { test, expect, type Page } from '@playwright/test';

async function setup(page: Page) {
  const servers = [
    { id: 'online', name: 'Online world', status: 'running', players: 3, maxPlayers: 20, game: { gameMode: 'creative', renderDistance: 12 } },
    { id: 'offline', name: 'Offline world', status: 'stopped', players: 0, maxPlayers: 30, game: { gameMode: 'survival', renderDistance: 32 } },
    { id: 'unknown', name: 'Unknown world', status: 'running', players: null, maxPlayers: 10, game: {} },
  ].map(server => ({ ...server, containerId: server.id, packReady: true, serverPort: 25565, resources: { minRamMb: 512, maxRamMb: 2048 }, serverPackName: 'old-pack.zip' }));
  await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { authenticated: true, authRequired: false } });
    if (path.endsWith('/host/capacity')) return route.fulfill({ status: 503, json: { error: 'Not part of this fixture' } });
    if (path.endsWith('/servers/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `event: servers\ndata: ${JSON.stringify(servers)}\n\n` });
    const server = servers.find(server => path.includes(`/servers/${server.id}`));
    if (server && path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `event: server\ndata: ${JSON.stringify(server)}\n\n` });
    if (server && path.endsWith(`/servers/${server.id}`)) {
      if (route.request().method() === 'PATCH') Object.assign(server, route.request().postDataJSON());
      return route.fulfill({ json: server });
    }
    if (path.endsWith('/servers')) return route.fulfill({ json: servers });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
}

for (const mobile of [false, true]) {
  test(`server list shows players, game and compact actions on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await setup(page);
    for (const value of ['3/20', '0/30', '—/10', 'creative', '12 chunks', 'survival', '32 chunks', 'Not available']) {
      await expect(page.getByText(value, { exact: true }).filter({ visible: true })).toBeVisible();
    }
    await expect(page.getByText('old-pack.zip', { exact: true })).toHaveCount(0);
    if (!mobile) {
      await expect(page.getByRole('columnheader', { name: 'Players' })).toBeVisible();
      const actions = await page.getByRole('columnheader', { name: 'Actions' }).boundingBox();
      expect(actions!.width).toBeLessThan(220);
    }
    await expect(page.getByRole('columnheader', { name: 'Server pack' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(2);
    await expect(page.getByRole('button', { name: /^(Edit|Restart|Rebuild)$/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`server-list-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
    await page.getByRole('button', { name: 'More actions for Online world' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rebuild', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Edit', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Restart', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Restart server' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'More actions for Offline world' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rebuild', exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Restart', exact: true })).toHaveCount(0);
  });
}

test('RAM edit submits the total container limit without adding overhead', async ({ page }) => {
  await setup(page);
  let submitted: { resources: { maxRamMb: number } } | undefined;
  await page.route('**/servers/offline', async route => {
    if (route.request().method() === 'PATCH') {
      submitted = route.request().postDataJSON();
    }
    return route.fallback();
  });
  await page.getByRole('link', { name: 'Settings for Offline world', exact: true }).click();
  await expect(page).toHaveURL(/\/servers\/offline\?tab=settings$/);
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('RAM limit (MiB)', { exact: true }).fill('10000');
  await expect(page.getByText('Total container memory, including Java overhead.')).toBeVisible();
  await page.getByRole('region', { name: 'Resources', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => submitted?.resources.maxRamMb).toBe(10000);
});

for (const success of [true, false]) {
  test(`server actions poll background jobs and show ${success ? 'completion' : 'failure'}`, async ({ page }) => {
    await setup(page);
    let submissions = 0;
    let polls = 0;
    await page.route('**/servers/offline/start', async route => {
      submissions++;
      expect(route.request().headers().prefer).toBe('respond-async');
      await route.fulfill({ status: 202, json: { operationId: 'operation-1', statusUrl: '/servers/offline/operations/operation-1' } });
    });
    await page.route('**/servers/offline/operations/operation-1', async route => {
      polls++;
      await route.fulfill({ json: polls < 3 ? { status: 'running' } : {
        status: success ? 'completed' : 'failed', httpStatus: success ? 200 : 422,
        body: success ? { id: 'offline', status: 'starting' } : { error: 'World could not be prepared', reason: 'Fixture failure: original world preserved' },
      } });
    });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect.poll(() => polls).toBeGreaterThanOrEqual(3);
    await expect(page.getByText(success ? 'Command sent.' : 'Fixture failure: original world preserved', { exact: true })).toBeVisible();
    expect(submissions).toBe(1);
  });
}
