// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from '@playwright/test';

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

test('task list shows running, finished and planned tasks and dismisses finished ones', async ({ page }, testInfo) => {
  const state = {
    running: [{ id: 'a:1', kind: 'scheduled-backup', serverId: 'a', serverName: 'Survival', startedAt: iso(-90_000),
      phase: 'archiving', bytesProcessed: 734_003_200, totalBytes: null, cancelRequested: false }],
    history: [
      { id: 'h1', kind: 'scheduled-backup', serverId: 'b', serverName: 'Creative', status: 'completed', startedAt: iso(-3_700_000),
        finishedAt: iso(-3_600_000), bytes: null, detail: 'Unchanged since the last backup; kept its archive.', error: null },
      { id: 'h2', kind: 'snapshot', serverId: 'c', serverName: 'Modpack', status: 'failed', startedAt: iso(-7_300_000),
        finishedAt: iso(-7_200_000), bytes: null, detail: null, error: 'The snapshot drive is not available.' },
    ],
    planned: [{ serverId: 'b', serverName: 'Creative', kind: 'scheduled-backup', intervalDays: 1, dueAt: iso(20 * 3_600_000), waitingFor: null, liveAt: iso(32 * 3_600_000) },
      { serverId: 'c', serverName: 'Modpack', kind: 'scheduled-backup', intervalDays: 7, dueAt: iso(-60_000), waitingFor: 'stop', liveAt: iso(11 * 3_600_000) }],
  };
  const deletes: string[] = [];
  await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { authenticated: true, authRequired: true } });
    if (path.includes('/tasks/history')) {
      deletes.push(path);
      const id = path.split('/tasks/history/')[1];
      state.history = id ? state.history.filter(task => task.id !== id) : [];
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/tasks')) return route.fulfill({ json: state });
    // Held open, so no "lost connection" toast covers the header.
    if (path.endsWith('/stream')) return new Promise(() => {});
    if (path.endsWith('/servers')) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: /^Tasks: 1 running, 2 finished/ });
  await expect(trigger).toBeVisible();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  await page.mouse.move(10, 10);   // the first synthetic hover after load does not count as one
  await trigger.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Tasks');
  await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Compressing')).toBeVisible();
  await expect(dialog.getByText('700.0 MB')).toBeVisible();
  await expect(dialog.getByText('The snapshot drive is not available.')).toBeVisible();
  await expect(dialog.getByText(/Waiting for the server to stop/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('tasks.png') });

  await dialog.getByRole('button', { name: 'Dismiss' }).first().click();
  await expect(dialog.getByText(/Unchanged/)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Clear all' }).click();
  await expect(dialog.getByText('The snapshot drive is not available.')).toHaveCount(0);
  expect(deletes.map(path => path.replace(/^\/api/, ''))).toEqual(['/tasks/history/h1', '/tasks/history']);
  // The button toggles: a second click closes the list instead of reopening it.
  await page.getByRole('button', { name: /^Tasks:/ }).click();
  await expect(dialog).toHaveCount(0);
});

test('the task list opens from the keyboard', async ({ page }) => {
  await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { authenticated: true, authRequired: false } });
    if (path.endsWith('/tasks')) return route.fulfill({ json: { running: [], history: [], planned: [] } });
    if (path.endsWith('/stream')) return new Promise(() => {});
    return route.fulfill({ json: [] });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Tasks:/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByText(/No tasks/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
