import { test, expect, type Page } from '@playwright/test';

const server = { id: 'snapshot-test', name: 'Snapshot test server', status: 'stopped', serverPort: 25565,
  resources: { minRamMb: 1024, maxRamMb: 2048 }, game: {}, packReady: true };
const running = { status: 'running', startedAt: '2026-10-19T12:00:00Z', finishedAt: null, error: null };
const snapshot = { id: 'snap-1', serverId: server.id, label: 'Navigation backup', fileName: 'test.tar.gz',
  sizeBytes: 4096, kind: 'manual', createdAt: '2026-10-19T12:01:00Z' };

async function setup(page: Page, withSnapshot = false, serverStatus = 'stopped') {
  const currentServer = { ...server, status: serverStatus };
  const state = { job: null as any, snapshots: (withSnapshot ? [snapshot] : []) as any[], listFailure: false, jobFailure: false, posts: 0, cancels: 0, cancelFailure: false, deletes: 0, restorePosts: 0, createSafetySnapshot: undefined as boolean | undefined,
    holdList: null as null | (() => Promise<void>), holdPost: null as null | (() => Promise<void>) };
  await page.route(/(?:localhost:4000\/|\/api\/)/, async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path.endsWith('/auth/me')) return json({ authenticated: true, authRequired: false });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: `event: server\ndata: ${JSON.stringify(currentServer)}\n\n` });
    if (path.endsWith('/snapshots/job/cancel')) {
      expect(route.request().method()).toBe('POST');
      expect(route.request().postDataJSON().startedAt).toBe(state.job.startedAt);
      state.cancels++;
      if (state.cancelFailure) return json({ error: 'Could not cancel the snapshot' }, 503);
      state.job = { ...state.job, cancelRequested: true };
      return json(state.job, 202);
    }
    if (path.endsWith('/snapshots/job')) return state.jobFailure ? json({ error: 'Job status unavailable' }, 500) : json(state.job);
    if (path.endsWith(`/snapshots/${snapshot.id}`) && route.request().method() === 'DELETE') {
      state.deletes++;
      state.snapshots = [];
      return json({ ok: true });
    }
    if (path.endsWith('/restore') && route.request().method() === 'POST') {
      expect(route.request().headers().prefer).toBe('respond-async');
      state.restorePosts++;
      state.createSafetySnapshot = route.request().postDataJSON().createSafetySnapshot;
      state.job = { ...running, operation: 'restore', snapshotId: snapshot.id, createSafetySnapshot: state.createSafetySnapshot, phase: 'validating',
        startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), bytesProcessed: 1024, totalBytes: 4096 };
      await state.holdPost?.();
      return json({ operationId: 'restore-op', statusUrl: `/servers/${server.id}/operations/restore-op` }, 202);
    }
    if (path.endsWith('/operations/restore-op')) return json({ status: state.job.status,
      httpStatus: state.job.status === 'failed' ? 500 : 200, body: state.job.status === 'failed' ? { error: state.job.error } : { ok: true } });
    if (path.endsWith('/snapshots')) {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON().background).toBe(true);
        state.posts++;
        state.job = { ...running, operation: 'create', phase: 'checking-files', bytesProcessed: 0,
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await state.holdPost?.();
        return json(state.job, 202);
      }
      await state.holdList?.();
      return state.listFailure ? json({ error: 'Archive list unavailable' }, 500) : json(state.snapshots);
    }
    if (path.endsWith('/logs')) return route.fulfill({ contentType: 'text/plain', body: 'Server logs\n' });
    if (path.endsWith('/metrics/history')) return json({ points: [], resolution: 60 });
    if (path.endsWith(`/servers/${server.id}`)) return json(currentServer);
    return json({});
  });
  await page.goto(`/servers/${server.id}`);
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeEnabled();
  return state;
}

test('disabled Restore explains why on hover and keyboard focus', async ({ page }) => {
  const state = await setup(page, true, 'running');
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  const trigger = page.getByRole('group', { name: 'Restore unavailable', exact: true });
  await trigger.hover();
  await expect(page.getByRole('tooltip')).toContainText('Stop the server before restoring a snapshot.');
  await page.screenshot({ path: test.info().outputPath('disabled-restore-tooltip.png'), fullPage: true });
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).not.toBeVisible();
  await page.keyboard.press('Tab');
  await trigger.focus();
  await expect(page.getByRole('tooltip')).toContainText('Stop the server before restoring a snapshot.');
  expect(state.restorePosts).toBe(0);
});

test('disabled snapshot and server actions explain missing prerequisites and active work', async ({ page }) => {
  const state = await setup(page, true);
  await page.getByRole('group', { name: 'Start unavailable', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('Prepare the server before starting it.');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText('Creating snapshot', { exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Restore unavailable', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('A snapshot is already being created.');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.getByRole('group', { name: 'Delete snapshot unavailable', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('A snapshot is already being created.');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  state.job = { ...state.job, status: 'completed', finishedAt: new Date().toISOString() };
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled({ timeout: 8000 });
  state.jobFailure = true;
  await expect(page.getByText('Job status unavailable')).toBeVisible({ timeout: 8000 });
  await page.getByRole('group', { name: 'Restore unavailable', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toContainText('Snapshot status is unavailable. Reconnecting…');
});

test('snapshot cancellation survives reload, keeps controls locked during cleanup, and allows another snapshot', async ({ page }) => {
  const state = await setup(page, true);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText('Creating snapshot', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Snapshot stages' })).not.toBeVisible();
  await page.getByRole('button', { name: 'Cancel snapshot', exact: true }).click();
  await expect(page.getByText('Cancelling snapshot…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel snapshot', exact: true })).toBeDisabled();
  await page.reload();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Cancelling snapshot…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel snapshot', exact: true })).toBeDisabled();
  state.job = { ...state.job, status: 'cancelled', finishedAt: new Date().toISOString() };
  await expect(page.getByText('Snapshot cancelled', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('The partial archive was removed. Your server files are unchanged.')).toBeVisible();
  await expect(page.getByText('Navigation backup', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel snapshot', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText('Creating snapshot', { exact: true })).toBeVisible();
  expect(state.posts).toBe(2);
  expect(state.cancels).toBe(1);
});

test('failed cancellation leaves the running snapshot visible and permits a retry', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText('Creating snapshot', { exact: true })).toBeVisible();
  state.cancelFailure = true;
  await page.getByRole('button', { name: 'Cancel snapshot', exact: true }).click();
  await expect(page.getByText('Could not cancel the snapshot', { exact: true })).toBeVisible();
  await expect(page.getByText('Creating snapshot', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel snapshot', exact: true })).toBeEnabled();
  state.cancelFailure = false;
  await page.getByRole('button', { name: 'Cancel snapshot', exact: true }).click();
  await expect(page.getByText('Cancelling snapshot…')).toBeVisible();
  expect(state.cancels).toBe(2);
});

for (const mobile of [false, true]) test(`snapshot deletion uses a cancellable HeroUI modal (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const state = await setup(page, true);
  const open = page.getByRole('button', { name: 'Delete snapshot', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Delete snapshot?' });
  await expect(dialog).toContainText('Navigation backup');
  await expect(dialog).toContainText('This cannot be undone.');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect.poll(() => dialog.evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) < 1) return false;
    }
    return true;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('delete-snapshot-modal.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(state.deletes).toBe(0);
  await open.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(state.deletes).toBe(0);
  await open.click();
  await dialog.getByRole('button', { name: 'Delete snapshot', exact: true }).click();
  await expect.poll(() => state.deletes).toBe(1);
  await expect(page.getByText('No completed snapshots yet.', { exact: true })).toBeVisible();
});

test('snapshot creation survives Logs tab, remount, reload and completion while away', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible();
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await expect(page.getByText(/^Creating snapshot$/)).not.toBeVisible();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
  await page.reload();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible();
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  state.job = { ...running, status: 'completed', finishedAt: snapshot.createdAt };
  state.snapshots = [snapshot];
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Navigation backup', { exact: true })).toBeVisible();
  await expect(page.getByText(/Last snapshot completed/)).toBeVisible();
  expect(state.posts).toBe(1);
});

for (const mobile of [false, true]) test(`snapshot creation shows live archive activity and preserves progress across reload (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText('Step 1 of 5 · Checking server files')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Checking server files' })).toBeVisible();
  state.job = { ...state.job, phase: 'archiving', bytesProcessed: 1048576 };
  await expect(page.getByText('Archive written: 1.0 MB')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('Step 3 of 5 · Compressing snapshot')).toBeVisible();
  await expect(page.getByText(/Elapsed:/)).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Compressing snapshot' })).not.toHaveAttribute('aria-valuenow');
  state.job = { ...state.job, bytesProcessed: 2097152 };
  await page.reload();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Archive written: 2.0 MB')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Snapshot stages' })).not.toBeVisible();
  await page.getByText('Details', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Snapshot stages' })).toContainText('✓ Saving world to disk');
  await expect(page.getByText(/Status checked/)).toBeVisible();
  await page.getByText('Details', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('snapshot-creation-progress.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1280);
  state.job = { ...state.job, phase: 'resuming' };
  await expect(page.getByText('Step 4 of 5 · Re-enabling autosaves')).toBeVisible({ timeout: 8000 });
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
  state.job = { ...state.job, status: 'completed', phase: 'finalizing', finishedAt: new Date().toISOString() };
  state.snapshots = [snapshot];
  await expect(page.getByText(/Last snapshot completed/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/Duration:.*Archive size: 2.0 MB/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeEnabled();
  expect(state.posts).toBe(1);
});

test('snapshot creation distinguishes stale activity from unavailable status and recovers', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText('Step 1 of 5 · Checking server files')).toBeVisible();
  state.job = { ...state.job, phase: 'archiving', bytesProcessed: 1024, updatedAt: new Date(Date.now() - 60000).toISOString() };
  await expect(page.getByText(/No new progress for/)).toBeVisible({ timeout: 8000 });
  state.jobFailure = true;
  await expect(page.getByText(/Status unavailable — reconnecting/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('Archive written: 1.0 KB')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
  state.jobFailure = false;
  state.job = { ...state.job, bytesProcessed: 2048, updatedAt: new Date().toISOString() };
  await expect(page.getByText('Archive written: 2.0 KB')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/No new progress for/)).not.toBeVisible();
});

for (const mobile of [false, true]) test(`restore modal defaults to backup, resets on reopen and supports opt-out (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const state = await setup(page, true);
  const open = page.getByRole('button', { name: 'Restore', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog');
  const checkbox = dialog.getByRole('checkbox', { name: 'Back up the current state first' });
  await expect(checkbox).toBeChecked();
  await expect(dialog).toContainText('Recommended.');
  await expect(dialog).toContainText('Navigation backup');
  await expect.poll(() => dialog.evaluate(element => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) < 1) return false;
    }
    return true;
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('restore-modal-default.png'), fullPage: true });
  await checkbox.uncheck();
  await expect(dialog.getByRole('alert')).toContainText('without a new backup');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(state.restorePosts).toBe(0);
  await open.click();
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await expect(dialog).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('restore-modal-without-backup.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Restore without backup', exact: true }).click();
  await expect.poll(() => state.restorePosts).toBe(1);
  expect(state.createSafetySnapshot).toBe(false);
  await expect(page.getByText('Step 1 of 4 · Checking snapshot')).toBeVisible({ timeout: 8000 });
  await page.getByText('Details', { exact: true }).click();
  await expect(page.getByRole('list', { name: 'Restore stages' })).not.toContainText('Creating safety backup');
  state.job = { ...state.job, phase: 'extracting' };
  await page.reload();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Step 3 of 4 · Extracting snapshot')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(mobile ? 390 : 1280);
});

test('restore shows stages and byte progress, survives navigation and reload, and reports success', async ({ page }) => {
  const state = await setup(page, true);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Back up and restore', exact: true }).click();
  await expect(page.getByText('Starting restore… Checking that the server is stopped.')).toBeVisible();
  await expect(page.getByText('Step 1 of 5 · Checking snapshot')).toBeVisible({ timeout: 8000 });
  expect(state.createSafetySnapshot).toBe(true);
  await expect(page.getByRole('progressbar', { name: 'Checking snapshot' })).toHaveAttribute('aria-valuenow', '25');
  await expect(page.getByText(/Elapsed:/)).toBeVisible();
  state.job = { ...state.job, phase: 'backup', bytesProcessed: 2048, totalBytes: null };
  await expect(page.getByText('Step 2 of 5 · Creating safety backup')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('Safety archive written: 2.0 KB')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete snapshot' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  state.job = { ...state.job, phase: 'extracting', bytesProcessed: 3072, totalBytes: 4096, safetySnapshotId: 'safety-1' };
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Step 4 of 5 · Extracting snapshot')).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: 'Extracting snapshot' })).toHaveAttribute('aria-valuenow', '75');
  await expect.poll(() => page.getByRole('progressbar', { name: 'Extracting snapshot' }).locator('div').last().evaluate(element =>
    new DOMMatrix(getComputedStyle(element).transform).m41 / element.getBoundingClientRect().width
  )).toBeCloseTo(-0.25, 2);
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('restore-progress.png'), fullPage: true });
  state.job = { ...state.job, status: 'completed', phase: 'permissions', finishedAt: new Date().toISOString() };
  await expect(page.getByText('Restore completed', { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/Your server is ready to start/)).toBeVisible();
  await page.getByText('Details', { exact: true }).click();
  await expect(page.getByText('Your automatic safety backup is available in the snapshot list.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
  expect(state.restorePosts).toBe(1);
});

test('restore status remains visible across polling errors and failure while away', async ({ page }) => {
  const state = await setup(page, true);
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Back up and restore', exact: true }).click();
  await expect(page.getByText('Restoring snapshot', { exact: true })).toBeVisible({ timeout: 8000 });
  state.jobFailure = true;
  await expect(page.getByText(/Status unavailable — reconnecting/)).toBeVisible({ timeout: 8000 });
  await expect(page.getByText('Restoring snapshot', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  state.jobFailure = false;
  state.job = { ...state.job, phase: 'backup', totalBytes: null, updatedAt: new Date(Date.now() - 60000).toISOString() };
  await expect(page.getByText(/No new file activity/)).toBeVisible({ timeout: 8000 });
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  state.job = { ...state.job, status: 'failed', finishedAt: new Date().toISOString(), error: 'Disk full. Existing server data has not been replaced.' };
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  const failure = page.getByRole('tabpanel', { name: 'Snapshots' }).getByRole('alert');
  await expect(failure).toContainText('Restore failed');
  await expect(failure).toContainText('Existing server data has not been replaced.');
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
});

test('leaving before restore acceptance still recovers the running restore', async ({ page }) => {
  const state = await setup(page, true);
  let release!: () => void;
  state.holdPost = () => new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Back up and restore', exact: true }).click();
  await expect.poll(() => state.restorePosts).toBe(1);
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText('Step 1 of 5 · Checking snapshot')).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
});

test('switching tabs before the create response arrives restores the accepted job', async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  state.holdPost = () => new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect.poll(() => state.posts).toBe(1);
  await page.getByRole('tab', { name: 'Logs', exact: true }).click();
  await page.getByRole('tab', { name: 'Snapshots', exact: true }).click();
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible();
  release();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
});

test('failure while away remains visible when returning', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible();
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
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
});

test('a stale poll cannot overwrite a newly accepted snapshot job', async ({ page }) => {
  const state = await setup(page);
  let release!: () => void;
  state.holdList = () => new Promise<void>(resolve => { release = resolve; });
  await expect.poll(() => !!release).toBe(true);
  state.holdList = null;
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible();
  release();
  // Wait for the held response to be rendered; a lost indicator here used to
  // stay missing until the next three-second poll.
  await page.waitForTimeout(300);
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible({ timeout: 500 });
  await expect(page.getByRole('button', { name: 'Take snapshot' })).toBeDisabled();
});

test('completion is picked up automatically without leaving or refreshing', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: 'Take snapshot' }).click();
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible();
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
  await expect(page.getByText(/^Creating snapshot$/)).toBeVisible({ timeout: 8000 });
});
