import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvc-cli-'));
  const src = join(dir, 'report.html');
  writeFileSync(src, '<h1>v1</h1>', 'utf8');
  return { dir, src };
};

test('commit then readHistory via CLI returns JSON history', () => {
  const { dir, src } = setup();
  try {
    runCli(['history', src]);                 // seed v1 at original content first
    writeFileSync(src, '<h1>v2</h1>', 'utf8');
    runCli(['commit', src, 'Second version']);
    const out = runCli(['history', src]);
    const h = JSON.parse(out);
    assert.equal(h.versions.length, 2);
    assert.equal(h.versions[0].title, 'Second version');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restore via CLI writes old content back', () => {
  const { dir, src } = setup();
  try {
    runCli(['history', src]);                 // seed v1 at original content first
    writeFileSync(src, '<h1>v2</h1>', 'utf8');
    runCli(['commit', src, 'Second']);
    runCli(['restore', src, '1']);
    assert.equal(readFileSync(src, 'utf8'), '<h1>v1</h1>');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('record-publish stores a publish record readable via history', () => {
  const { dir, src } = setup();
  try {
    runCli(['history', src]);   // seed v1
    runCli(['record-publish', src, '1', '--access', 'public',
      '--public-url', 'https://s3/x', '--expires-at', '2026-06-12T00:00:00.000Z']);
    const h = JSON.parse(runCli(['history', src]));
    const v1 = h.versions.find((x) => x.n === 1);
    assert.equal(v1.published.length, 1);
    assert.equal(v1.published[0].access, 'public');
    assert.equal(v1.published[0].publicUrl, 'https://s3/x');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Regression: run the CLI as a real subprocess (not the in-process function) so
// the direct-invocation guard is exercised. Catches the spaces-in-path bug
// where import.meta.url (percent-encoded) != `file://${argv[1]}` (raw).
test('CLI runs as a subprocess and actually commits (entry-point guard)', () => {
  const { dir, src } = setup();
  try {
    execFileSync('node', [CLI, 'history', src], { encoding: 'utf8' });   // seed
    writeFileSync(src, '<h1>v2</h1>', 'utf8');
    const committed = execFileSync('node', [CLI, 'commit', src, 'Second'], { encoding: 'utf8' });
    assert.match(committed, /"n":\s*2/);
    const out = execFileSync('node', [CLI, 'history', src], { encoding: 'utf8' });
    assert.equal(JSON.parse(out).versions.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
