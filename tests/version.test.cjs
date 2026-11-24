// SPDX-License-Identifier: AGPL-3.0-only

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const version = require('../scripts/version.cjs');

const ROOT = path.join(__dirname, '..');

test('the root, backend and frontend manifests and lockfiles carry one version', () => {
  const current = version.currentVersion();
  assert.match(current, /^\d+\.\d+\.\d+$/);
  for (const entry of version.readVersions()) assert.equal(entry.value, current, entry.label);
});

test('versions compare numerically, not as text', () => {
  assert.ok(version.compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(version.compareVersions('2.0.0', '10.0.0') < 0);
  assert.equal(version.compareVersions('1.2.3', '1.2.3'), 0);
  assert.throws(() => version.compareVersions('1.2', '1.2.0'), /major\.minor\.patch/);
  assert.throws(() => version.parseVersion('1.2.3-beta.1'), /major\.minor\.patch/);
});

test('a bump resets the lower parts', () => {
  assert.equal(version.bumpVersion('1.4.7', 'patch'), '1.4.8');
  assert.equal(version.bumpVersion('1.4.7', 'minor'), '1.5.0');
  assert.equal(version.bumpVersion('1.4.7', 'major'), '2.0.0');
  assert.throws(() => version.bumpVersion('1.4.7', 'huge'), /major", "minor" or "patch/);
});

/** A throwaway git repository holding copies of the six versioned files. */
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dash-version-'));
  for (const sub of ['.', 'backend', 'frontend']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (const name of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(ROOT, sub, name), path.join(dir, sub, name));
    }
  }
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'base');
  return dir;
}

test('setVersion updates all six places and leaves the rest of each file alone', () => {
  const dir = scratchRepo();
  try {
    const before = version.currentVersion(dir);
    const next = version.bumpVersion(before, 'minor');
    version.setVersion(next, dir);
    assert.equal(version.currentVersion(dir), next);
    const diff = execFileSync('git', ['diff', '--numstat'], { cwd: dir, encoding: 'utf8' }).trim().split('\n');
    // One changed line per manifest, two per lockfile; nothing reformatted.
    const changed = Object.fromEntries(diff.map((line) => {
      const [added, removed, file] = line.split('\t');
      return [file, `${added}/${removed}`];
    }));
    assert.deepEqual(changed, {
      'package.json': '1/1', 'package-lock.json': '2/2',
      'backend/package.json': '1/1', 'backend/package-lock.json': '2/2',
      'frontend/package.json': '1/1', 'frontend/package-lock.json': '2/2',
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the pull request check requires a version higher than the target branch', () => {
  const dir = scratchRepo();
  try {
    const base = version.currentVersion(dir);
    assert.throws(() => version.checkBumped('HEAD', dir), /not higher than/);

    version.setVersion(version.bumpVersion(base, 'patch'), dir);
    assert.deepEqual(version.checkBumped('HEAD', dir), { current: version.bumpVersion(base, 'patch'), previous: base });

    // Only the backend bumped: caught as a disagreement, not as a valid bump.
    const manifest = path.join(dir, 'backend', 'package.json');
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    json.version = version.bumpVersion(base, 'major');
    fs.writeFileSync(manifest, `${JSON.stringify(json, null, 2)}\n`);
    assert.throws(() => version.checkBumped('HEAD', dir), /backend\/package\.json: /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
