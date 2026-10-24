import { expect, test } from '@playwright/test';

for (const failure of ['password', 'session', 'network'] as const) {
  for (const retry of ['button', 'Enter'] as const) {
    test(`login retries after ${failure} error using ${retry}`, async ({ page }) => {
      let attempts = 0;
      await page.route(/(?:localhost:4000\/|\/api\/)auth\//, async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith('/me')) {
          await route.fulfill({ json: { authRequired: true, authenticated: false } });
        } else if (pathname.endsWith('/login')) {
          attempts++;
          if (failure === 'network') await route.abort();
          else await route.fulfill({ status: failure === 'password' ? 401 : 200, json: {} });
        } else await route.fulfill({ json: {} });
      });
      await page.goto('/');
      const password = page.getByLabel('Password', { exact: true });
      const submit = page.getByRole('button', { name: 'Sign in' });
      await password.fill('test-login-password');
      await submit.click();
      const message = failure === 'password' ? 'Incorrect password' : failure === 'network'
        ? 'Could not reach the server.' : 'Password accepted, but the session could not be established.';
      await expect(page.getByText(message, { exact: failure !== 'session' })).toBeVisible();
      await expect(submit).toBeEnabled();
      // A session error clears the password; other errors allow an unchanged retry.
      if (failure === 'session') await password.fill('test-login-password');
      if (retry === 'button') await submit.click();
      else await password.press('Enter');
      await expect.poll(() => attempts).toBe(2);
    });
  }
}
