Run from `frontend/`:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

Playwright starts a dedicated Next.js development server on 127.0.0.1:3109.
The snapshot tests exercise the real server details page and its tabs in
Chromium, with controlled API responses to reproduce pending requests, backend
failures and completion while the tab is unmounted. They do not contact a live
Minecraft server or validate live-world backup consistency.

Backend snapshot tests separately exercise archive creation, SQLite job state,
the background creation endpoint, failure/retry and interrupted-job recovery:

```sh
cd ../backend
node -r ts-node/register --test src/services/snapshotService.test.ts
```
