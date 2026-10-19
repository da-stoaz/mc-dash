import { test, expect, type Page } from '@playwright/test';

const server = { id: 'snapshot-test', name: 'Snapshot test server', status: 'stopped', serverPort: 25565,
  resources: { minRamMb: 1024, maxRamMb: 2048 }, game: {}, packReady: true };
const running = { status: 'running', startedAt: '2026-10-19T12:00:00Z', finishedAt: null, error: null };
const snapshot = { id: 'snap-1', serverId: server.id, label: 'Navigation backup', fileName: 'test.tar.gz',
  sizeBytes: 4096, kind: 'manual', createdAt: '2026-10-19T12:01:00Z' };

async function setup(page: Page) {
  const state = { job: null as any, snapshots: [] as any[], listFailure: false, jobFailure: false, posts: 0,
    holdList: null as null | (() => Promise<void>), holdPost: null as null | (() => Promise<void>) };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/auth/me') return json({ authenticated: true, authRequired: false });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `event: server\ndata: ${JSON.stringify(server)}\n\n` });
    if (path.endsWith('/snapshots/job')) return state.jobFailure ? json({ error: 'Job status unavailable' }, 500) : json(state.job);
    if (path.endsWith('/snapshots')) {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON().background).toBe(true);
        state.posts++;
        state.job = { ...running };
        await state.holdPost?.();
        return json(state.job, 202);
      }
      await state.holdList?.();
      return state.listFailure ? json({ error: 'Archive list unavailable' }, 500) : json(state.snapshots);
    }
    if (path.endsWith('/logs')) return route.fulfill({ contentType: 'text/plain', body: 'Server logs\n' });
    if (path.endsWith('/metrics/history')) return json({ points: [], resolution: 60 });
    if (path.endsWith(`/servers/${server.id}`)) return json(server);
    return json({});
  });
  await page.goto(`/servers/${server.id}`);
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeEnabled();
  return state;
}

test('snapshot creation survives Logs tab, remount, reload and completion while away', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible();
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await expect(page.getByText(/Creating snapshot · started/)).not.toBeVisible();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
  await page.reload();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible();
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  state.job = { ...running, status: 'completed', finishedAt: snapshot.createdAt };
  state.snapshots = [snapshot];
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Navigation backup', { exact: true })).toBeVisible();
  await expect(page.getByText(/Last snapshot completed/)).toBeVisible();
  expect(state.posts).toBe(1);
});

test('switching tabs before the create response arrives restores the accepted job', async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  state.holdPost = () => new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect.poll(() => state.posts).toBe(1);
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
});

test('failure while away remains visible when returning', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible();
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  state.job = { ...running, status: 'failed', finishedAt: snapshot.createdAt, error: 'Disk full' };
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Snapshot failed: Disk full')).toBeVisible();
});

test('running job remains visible even when loading the archive list fails', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  state.job = { ...running };
  state.listFailure = true;
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Archive list unavailable')).toBeVisible();
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
});

test('a stale poll cannot overwrite a newly accepted snapshot job', async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  state.holdList = () => new Promise<void>(resolve => { release = resolve; });
  await expect.poll(() => !!release).toBe(true);
  state.holdList = null;
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible();
  release();
  // Wait for the held response to be rendered; a lost indicator here used to
  // stay missing until the next three-second poll.
  await page.waitForTimeout(300);
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible({ timeout: 500 });
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
});

test('completion is picked up automatically without leaving or refreshing', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible();
  state.job = { ...running, status: 'completed', finishedAt: snapshot.createdAt };
  state.snapshots = [snapshot];
  await expect(page.getByText('Navigation backup', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeEnabled();
});

test('unknown job status on return is not presented as permission to start another job', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  state.jobFailure = true;
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Job status unavailable')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
  state.jobFailure = false;
  state.job = { ...running };
  await expect(page.getByText(/Creating snapshot · started/)).toBeVisible({ timeout: 8000 });
});
