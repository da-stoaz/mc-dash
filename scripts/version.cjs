#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

// The MC Dash version lives in six places that must always agree: the root,
// backend and frontend package.json, and their package-lock.json files. Each
// image reads its own package.json, so the build needs no extra arguments.
//
//   node scripts/version.cjs                  print the current version
//   node scripts/version.cjs bump <part>      bump major, minor or patch everywhere
//   node scripts/version.cjs check            all six places agree
//   node scripts/version.cjs check --base <git-ref>
//                                             ...and the version is higher than at <git-ref>
//
// Every pull request bumps the version; CI runs `check --base` against the
// target branch, and publishes images and a GitHub release for each new version
// merged to main.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PACKAGE_DIRS = ['.', 'backend', 'frontend'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PARTS = ['major', 'minor', 'patch'];

function parseVersion(version) {
  const match = SEMVER.exec(String(version));
  if (!match) throw new Error(`"${version}" is not a plain major.minor.patch version`);
  return match.slice(1).map(Number);
}

/** Negative when a < b, zero when equal, positive when a > b. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function bumpVersion(version, part) {
  const index = PARTS.indexOf(part);
  if (index === -1) throw new Error(`Bump "major", "minor" or "patch", not "${part}"`);
  const parts = parseVersion(version);
  parts[index] += 1;
  for (let i = index + 1; i < 3; i += 1) parts[i] = 0;
  return parts.join('.');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Every place the version is recorded, as { label, value }. */
function readVersions(root = ROOT) {
  const found = [];
  for (const dir of PACKAGE_DIRS) {
    const manifest = path.join(dir, 'package.json');
    const lock = path.join(dir, 'package-lock.json');
    found.push({ label: manifest, value: readJson(path.join(root, manifest)).version });
    const lockJson = readJson(path.join(root, lock));
    found.push({ label: `${lock} (version)`, value: lockJson.version });
    found.push({ label: `${lock} (packages[""].version)`, value: lockJson.packages?.['']?.version });
  }
  return found;
}

/** The single version all places agree on; throws listing every mismatch. */
function currentVersion(root = ROOT) {
  const found = readVersions(root);
  const expected = found[0].value;
  parseVersion(expected);
  const mismatched = found.filter((entry) => entry.value !== expected);
  if (mismatched.length) {
    const lines = mismatched.map((entry) => `  ${entry.label}: ${entry.value}`).join('\n');
    throw new Error(`Versions disagree with package.json (${expected}):\n${lines}\nRun: npm run version:bump -- <major|minor|patch>`);
  }
  return expected;
}

function setVersion(version, root = ROOT) {
  parseVersion(version);
  for (const dir of PACKAGE_DIRS) {
    const manifestFile = path.join(root, dir, 'package.json');
    const manifest = readJson(manifestFile);
    manifest.version = version;
    writeJson(manifestFile, manifest);

    const lockFile = path.join(root, dir, 'package-lock.json');
    const lock = readJson(lockFile);
    lock.version = version;
    if (lock.packages?.['']) lock.packages[''].version = version;
    writeJson(lockFile, lock);
  }
}

/** The root package.json version at a git ref, e.g. the PR's target branch. */
function versionAt(ref, root = ROOT) {
  const text = execFileSync('git', ['show', `${ref}:package.json`], { cwd: root, encoding: 'utf8' });
  return JSON.parse(text).version;
}

function checkBumped(base, root = ROOT) {
  const current = currentVersion(root);
  const previous = versionAt(base, root);
  if (compareVersions(current, previous) <= 0) {
    throw new Error(
      `Version ${current} is not higher than ${previous} on ${base}. Every pull request bumps it:\n` +
        '  npm run version:bump -- patch   (fixes)\n' +
        '  npm run version:bump -- minor   (features)\n' +
        '  npm run version:bump -- major   (breaking changes)'
    );
  }
  return { current, previous };
}

function main(argv) {
  const [command, ...args] = argv;
  if (!command) {
    console.log(currentVersion());
    return;
  }
  if (command === 'bump') {
    const before = currentVersion();
    const after = bumpVersion(before, args[0]);
    setVersion(after);
    console.log(`${before} -> ${after}`);
    return;
  }
  if (command === 'check') {
    const baseIndex = args.indexOf('--base');
    if (baseIndex === -1) {
      console.log(`Version ${currentVersion()} is consistent.`);
      return;
    }
    const base = args[baseIndex + 1];
    if (!base) throw new Error('--base needs a git ref');
    const { current, previous } = checkBumped(base);
    console.log(`Version ${current} is consistent and higher than ${previous} on ${base}.`);
    return;
  }
  throw new Error(`Unknown command "${command}". Use: bump <major|minor|patch> | check [--base <git-ref>]`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { parseVersion, compareVersions, bumpVersion, readVersions, currentVersion, setVersion, versionAt, checkBumped };
