// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '../config';
import { logger } from '../logger';
import { appVersion, parseVersion } from '../version';

// ---------------------------------------------------------------------------
// "Is there a newer MC Dash?"
//
// CI creates a GitHub release for each new version only after both images for
// it are published, so the latest release is exactly what `docker compose pull`
// can fetch. The dashboard shows the running version next to it; an update
// that has been merged but not yet built never shows up as available.
//
// One unauthenticated request an hour (GitHub allows 60 an hour per IP), sent
// with a generic User-Agent and nothing about this installation.
// Turn it off with MC_DASH_UPDATE_CHECK=false.
// ---------------------------------------------------------------------------

const RELEASES_URL = 'https://api.github.com/repos/da-stoaz/mc-dash/releases/latest';
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export type LatestRelease = { version: string; url: string };

type Fetch = typeof fetch;

export class UpdateCheck {
  private latest: LatestRelease | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly fetchImpl: Fetch = (...args) => fetch(...args)) {}

  start() {
    if (!config.updateCheckEnabled || this.timer) return;
    void this.refresh();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** The newest published release, as last seen. Null until the first check succeeds. */
  latestRelease(): LatestRelease | null {
    return config.updateCheckEnabled ? this.latest : null;
  }

  /** Fetch the latest release now, and schedule the next check. Never throws. */
  async refresh(): Promise<LatestRelease | null> {
    let next = RETRY_INTERVAL_MS;
    try {
      const res = await this.fetchImpl(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `mc-dash/${appVersion}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 404) {
        // No release published yet: nothing newer to offer.
        this.latest = null;
        next = CHECK_INTERVAL_MS;
      } else if (!res.ok) {
        logger.debug({ status: res.status }, 'Update check: GitHub answered with an error');
      } else {
        const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
        const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
        const url = typeof body.html_url === 'string' && body.html_url.startsWith('https://github.com/') ? body.html_url : null;
        if (parseVersion(tag) && url) {
          this.latest = { version: tag.replace(/^v/, ''), url };
          next = CHECK_INTERVAL_MS;
        } else {
          logger.debug({ tag }, 'Update check: latest release has no usable version');
        }
      }
    } catch (err) {
      // Offline hosts and firewalled egress are normal; keep the last answer.
      logger.debug({ err }, 'Update check failed');
    }
    this.schedule(next);
    return this.latest;
  }

  private schedule(delayMs: number) {
    if (!config.updateCheckEnabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delayMs);
    this.timer.unref();
  }
}

export const updateCheck = new UpdateCheck();
