import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

// prepareService pulls in config.ts, whose import ensures the data dir exists.
// Point it at a throwaway dir before requiring so it can't create a stray
// ./data folder next to the source.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdash-java-'));
process.env.DATA_ROOT = TMP;
process.env.SQLITE_PATH = path.join(TMP, 'test.sqlite');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseRecommendedJavaMajor, toPublishedJavaMajor, PUBLISHED_JAVA_MAJORS } = require('./prepareService');

test('a modern Minecraft version is not misread as a 1.x one', () => {
  // Regression: /\b1\.(\d{1,2})\b/ matched the "1.2" inside "26.1.2" and mapped
  // the pack to Java 8, which will not run a modern server at all.
  assert.notEqual(parseRecommendedJavaMajor('26.1.2'), 8);
  assert.notEqual(parseRecommendedJavaMajor('1.26.1'), 8);
});

test('an unmapped version scheme defers to the configured default', () => {
  // undefined makes resolveJavaImage fall back to config.javaImage rather than
  // guessing a major we have no table for.
  assert.equal(parseRecommendedJavaMajor('26.1.2'), undefined);
});

test('classic Minecraft versions still map to the Java they need', () => {
  assert.equal(parseRecommendedJavaMajor('1.21.4'), 21);
  assert.equal(parseRecommendedJavaMajor('minecraft 1.20.1'), 17);
  assert.equal(parseRecommendedJavaMajor('1.18'), 17);
  assert.equal(parseRecommendedJavaMajor('1.12.2'), 8);
});

test('Minecraft 1.17 rounds up to a published image, not down', () => {
  // 1.17 wants Java 16, which Temurin publishes no -jre image for. Rounding up
  // to 17 runs; rounding down to 11 would not.
  assert.equal(parseRecommendedJavaMajor('1.17'), 17);
});

test('an explicit java version wins over any version-ish parsing', () => {
  assert.equal(parseRecommendedJavaMajor('java 21'), 21);
  assert.equal(parseRecommendedJavaMajor('temurin-17'), 17);
  assert.equal(parseRecommendedJavaMajor('Java 25'), 25);
});

test('bare majors are accepted', () => {
  assert.equal(parseRecommendedJavaMajor('21'), 21);
  assert.equal(parseRecommendedJavaMajor('8'), 8);
});

test('a recommended version is a minimum, so it rounds up', () => {
  assert.equal(toPublishedJavaMajor(16), 17);
  assert.equal(toPublishedJavaMajor(22), 25);
  assert.equal(toPublishedJavaMajor(9), 11);
  assert.equal(toPublishedJavaMajor(21), 21);
});

test('never resolves to an image tag Temurin does not publish', () => {
  // resolveJavaImage interpolates this straight into eclipse-temurin:<n>-jre,
  // so anything off this list is a guaranteed pull failure.
  for (const input of ['1.17', '1.21', 'java 22', '26', '99', '1.12.2', 'java 16']) {
    const major = parseRecommendedJavaMajor(input);
    if (major !== undefined) {
      assert.ok(PUBLISHED_JAVA_MAJORS.includes(major), `${input} -> unpublished major ${major}`);
    }
  }
});

test('a major beyond every published one defers rather than inventing a tag', () => {
  assert.equal(toPublishedJavaMajor(99), undefined);
});

test('garbage in, nothing out', () => {
  assert.equal(parseRecommendedJavaMajor(undefined), undefined);
  assert.equal(parseRecommendedJavaMajor(''), undefined);
  assert.equal(parseRecommendedJavaMajor('   '), undefined);
  assert.equal(parseRecommendedJavaMajor('latest'), undefined);
});
