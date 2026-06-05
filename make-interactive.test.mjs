import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'make-interactive.mjs');

test('generated page embeds the history payload and the picker overlay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvc-mi-'));
  try {
    const src = join(dir, 'report.html');
    writeFileSync(src, '<!doctype html><body><h1>Report</h1></body>', 'utf8');
    const out = join(dir, 'report.interactive.html');
    execFileSync('node', [SCRIPT, src, out], { encoding: 'utf8' });
    const html = readFileSync(out, 'utf8');
    assert.match(html, /window\.__DEVREV_PAGE_VERSIONS__/);
    assert.match(html, /Version history/);          // overlay button aria-label
    assert.match(html, /Toggle comments panel/);    // docks next to the Comments button
    assert.match(html, /"page":\s*"report\.html"/); // payload carries the page name
    assert.match(html, /Initial version/);          // seeded first version title

    // The injection must come AFTER the inlined runtime bundle, not be spliced
    // into the middle of it (the bundle contains its own literal "</body>").
    const versionsIdx = html.indexOf('__DEVREV_PAGE_VERSIONS__');
    const rootIdx = html.indexOf('id="root"');
    assert.ok(rootIdx !== -1 && versionsIdx > rootIdx,
      'versioning block should be injected near the end, after the app root');
    // And there must be exactly one trailing </body></html> closing the doc.
    assert.match(html.slice(-40), /<\/body>\s*<\/html>\s*$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function bakedVersions(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const m = html.match(/window\.__DEVREV_PAGE_VERSIONS__=(\{[\s\S]*?\});<\/script>/);
  return JSON.parse(m[1]).versions;
}
const bakedVersionCount = (p) => bakedVersions(p).length;

test('rebuilding after an edit auto-adds a version (no explicit commit needed)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvc-auto-'));
  try {
    const src = join(dir, 'report.html');
    const out = join(dir, 'report.interactive.html');

    writeFileSync(src, '<!doctype html><body><h1>v1</h1></body>', 'utf8');
    execFileSync('node', [SCRIPT, src, out], { encoding: 'utf8' });   // seeds v1
    assert.equal(bakedVersionCount(out), 1);

    // Simulate Computer editing the page from feedback, then rebuilding —
    // WITHOUT any explicit cli.mjs commit.
    writeFileSync(src, '<!doctype html><head><title>Acme Pricing</title></head><body><h1>v2 from feedback</h1></body>', 'utf8');
    execFileSync('node', [SCRIPT, src, out], { encoding: 'utf8' });
    assert.equal(bakedVersionCount(out), 2);                          // auto-committed
    // Fallback title is a plain honest label (agent is expected to commit with
    // a real title; this is the no-description exception).
    assert.match(bakedVersions(out)[0].title, /Edited \(no description\)/);

    // Rebuild again with no edit — must NOT add a phantom version.
    execFileSync('node', [SCRIPT, src, out], { encoding: 'utf8' });
    assert.equal(bakedVersionCount(out), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a published version renders in the picker payload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pvc-pub-'));
  try {
    const src = join(dir, 'report.html');
    const out = join(dir, 'report.interactive.html');
    writeFileSync(src, '<!doctype html><body><h1>v1</h1></body>', 'utf8');
    execFileSync('node', [SCRIPT, src, out], { encoding: 'utf8' });   // seed v1
    const CLI = join(here, 'version-store', 'cli.mjs');
    execFileSync('node', [CLI, 'record-publish', src, '1',
      '--access', 'public', '--public-url', 'https://s3/demo',
      '--expires-at', '2026-06-12T00:00:00.000Z', '--at', '2026-06-05T00:00:00.000Z'],
      { encoding: 'utf8' });
    execFileSync('node', [SCRIPT, src, out], { encoding: 'utf8' });
    const v = bakedVersions(out).find((x) => x.n === 1);
    assert.equal(v.published.length, 1);
    assert.equal(v.published[0].publicUrl, 'https://s3/demo');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
