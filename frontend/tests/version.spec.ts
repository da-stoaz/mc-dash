// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect, type Page } from '@playwright/test';
import packageJson from '../package.json';

const version = packageJson.version;
const [major, minor, patch] = version.split('.').map(Number);
const next = `${major}.${minor + 1}.0`;
const older = patch > 0 ? `${major}.${minor}.${patch - 1}` : `${major}.${Math.max(minor - 1, 0)}.9`;
const releaseUrl = `https://github.com/da-stoaz/mc-dash/releases/tag/v${next}`;

async function openWithConfig(page: Page, config: Record<string, unknown>) {
  await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { authenticated: true, authRequired: false } });
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: 'event: servers\ndata: []\n\n' });
    if (path.endsWith('/servers')) return route.fulfill({ json: [] });
    if (path.endsWith('/config')) return route.fulfill({ json: { routerEnabled: false, routerDomain: null, ...config } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
  return page.getByTestId('app-version');
}

test('the header shows the running version, and nothing else when it is current', async ({ page }) => {
  const badge = await openWithConfig(page, { version, latestVersion: version, latestReleaseUrl: releaseUrl.replace(next, version) });
  await expect(badge).toHaveText(`v${version}`);
  await expect(badge.getByRole('link')).toHaveCount(0);
});

test('a newer published release links to its notes', async ({ page }, testInfo) => {
  const badge = await openWithConfig(page, { version, latestVersion: next, latestReleaseUrl: releaseUrl });
  const link = badge.getByRole('link', { name: `v${next} available` });
  await expect(link).toHaveAttribute('href', releaseUrl);
  await expect(link).toHaveAttribute('target', '_blank');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('version-update-mobile.png') });
});

test('frontend and backend on different versions are called out', async ({ page }) => {
  const badge = await openWithConfig(page, { version: older, latestVersion: version, latestReleaseUrl: releaseUrl });
  await expect(badge).toContainText(`backend v${older}`);
  // The backend is behind, so the current release is still an update for it.
  await expect(badge.getByRole('link', { name: `v${version} available` })).toBeVisible();
});

test('without an update check, only the version shows', async ({ page }) => {
  const badge = await openWithConfig(page, { version, latestVersion: null, latestReleaseUrl: null });
  await expect(badge).toHaveText(`v${version}`);
});
