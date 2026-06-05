import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBackend } from './detect.mjs';

test('prefers git when git is present', () => {
  const got = chooseBackend({ hasGit: () => true, hasBrew: () => false, install: () => {} });
  assert.equal(got, 'git');
});

test('installs via brew then uses git when git absent but brew present', () => {
  let installed = false;
  const got = chooseBackend({
    hasGit: () => installed,           // becomes true after install
    hasBrew: () => true,
    install: () => { installed = true; },
  });
  assert.equal(got, 'git');
  assert.equal(installed, true);
});

test('falls back to file store when neither git nor brew present', () => {
  const got = chooseBackend({ hasGit: () => false, hasBrew: () => false, install: () => {} });
  assert.equal(got, 'file');
});
