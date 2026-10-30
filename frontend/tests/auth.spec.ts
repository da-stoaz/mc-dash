import { test, expect } from '@playwright/test';

const failures = [
  { name: 'incorrect password', status: 401, message: 'Incorrect password' },
  { name: 'rate limit', status: 429, message: 'Too many login attempts' },
  { name: 'server error', status: 500, message: 'Login failed' },
  { name: 'network error', status: 0, message: 'Could not reach the server.' },
  { name: 'missing session', status: 200, message: 'Password accepted, but the session could not be established.' },
];

for (const failure of failures) {
  for (const submitWith of ['button', 'Enter'] as const) {
    test(`can retry with ${submitWith} after ${failure.name}`, async ({ page }) => {
      const passwords: string[] = [];
      let authenticated = false;
      await page.route(/(?:localhost:4000\/|\/api\/)/, async route => {
        const pathname = new URL(route.request().url()).pathname.replace(/^\/api/, '');
        if (pathname === '/auth/me') {
          return route.fulfill({ json: { authRequired: true, authenticated } });
        }
        if (pathname === '/auth/login') {
          passwords.push(route.request().postDataJSON().password);
          if (passwords.length === 1) {
            if (failure.status === 0) return route.abort('failed');
            return route.fulfill({ status: failure.status, json: { ok: failure.status === 200 } });
          }
          authenticated = true;
          return route.fulfill({ json: { ok: true } });
        }
        return route.fulfill({ json: pathname === '/servers' ? [] : {} });
      });

      await page.goto('/');
      const password = page.getByLabel('Password', { exact: true });
      const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
      await password.fill('first-password');
      await signIn.click();
      await expect(page.getByText(failure.message, { exact: false })).toBeVisible();
      await expect(signIn).toBeEnabled();

      // Retry the same rejected password without editing it. Session failures
      // clear the field, so refill it as a user would before trying again.
      if (failure.status === 200) await password.fill('first-password');
      if (submitWith === 'button') await signIn.click();
      else await password.press('Enter');

      await expect.poll(() => passwords.length).toBe(2);
      expect(passwords).toEqual(['first-password', 'first-password']);
      await expect(signIn).toHaveCount(0);
    });
  }
}

test('an empty password does not send a login request', async ({ page }) => {
  let logins = 0;
  await page.route(/(?:localhost:4000\/|\/api\/)/, route => {
    if (route.request().url().endsWith('/auth/login')) logins++;
    return route.fulfill({ json: { authRequired: true, authenticated: false } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  expect(logins).toBe(0);
});


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
