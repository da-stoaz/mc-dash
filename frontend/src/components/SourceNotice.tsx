// SPDX-License-Identifier: AGPL-3.0-only

import { LICENSE_URL, SOURCE_CODE_URL } from '../lib/project';

const linkClass = 'whitespace-nowrap underline-offset-2 hover:text-white/70 hover:underline';

/** License notice and source offer shown to everyone using the dashboard. */
export function SourceNotice() {
  return (
    <footer className="mt-10 text-center text-xs text-white/40">
      MC Dash is free software under the{' '}
      <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
        GNU AGPL v3
      </a>
      {' · '}
      <a href={SOURCE_CODE_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
        Source code
      </a>
    </footer>
  );
}
