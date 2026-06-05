import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run the shared behavioral contract against a backend.
 * @param {string} label  e.g. "FileStore"
 * @param {(sourcePath:string, opts:object)=>object} createStore  backend factory
 */
export function runStoreContract(label, createStore) {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pvc-'));
    const src = join(dir, 'report.html');
    writeFileSync(src, '<h1>v1</h1>', 'utf8');
    return { dir, src };
  };
  const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

  test(`[${label}] seeds an initial Computer-authored version`, () => {
    const { dir, src } = setup();
    try {
      const store = createStore(src, { identityName: 'Test Author' });
      const h = store.readHistory();
      assert.equal(h.page, 'report.html');
      assert.equal(h.currentBranch, 'main');
      assert.deepEqual(h.branches, ['main']);
      assert.equal(h.versions.length, 1);
      assert.equal(h.versions[0].n, 1);
      assert.equal(h.versions[0].author, 'Computer');
      assert.equal(h.versions[0].isRestore, false);
      assert.equal(h.versions[0].restoredFrom, null);
      assert.equal(h.currentCommit, h.versions[0].hash);
    } finally { cleanup(dir); }
  });

  test(`[${label}] commit appends a user-authored version, newest first`, () => {
    const { dir, src } = setup();
    try {
      const store = createStore(src, { identityName: 'Test Author' });
      writeFileSync(src, '<h1>v2</h1>', 'utf8');
      const v = store.commit('Add pricing table');
      assert.equal(v.n, 2);
      assert.equal(v.title, 'Add pricing table');
      assert.equal(v.author, 'Test Author');
      const h = store.readHistory();
      assert.equal(h.versions.length, 2);
      assert.equal(h.versions[0].n, 2);          // newest first
      assert.equal(h.versions[1].n, 1);
      assert.equal(h.currentCommit, h.versions[0].hash);
    } finally { cleanup(dir); }
  });

  test(`[${label}] commit stores change bullets (body) and reads them back`, () => {
    const { dir, src } = setup();
    try {
      const store = createStore(src, { identityName: 'Test Author' });
      writeFileSync(src, '<h1>v2</h1>', 'utf8');
      const v = store.commit('Remove decimals, recolour metric', {
        body: ['Removed decimals in percentages', 'Recoloured the chat-ceiling metric'],
      });
      assert.deepEqual(v.body, ['Removed decimals in percentages', 'Recoloured the chat-ceiling metric']);
      const top = store.readHistory().versions[0];
      assert.equal(top.title, 'Remove decimals, recolour metric');
      assert.deepEqual(top.body, ['Removed decimals in percentages', 'Recoloured the chat-ceiling metric']);
      // Seed version has an empty body, not undefined.
      assert.deepEqual(store.readHistory().versions[1].body, []);
    } finally { cleanup(dir); }
  });

  test(`[${label}] recordPublish appends a publish record to a version`, () => {
    const { dir, src } = setup();
    try {
      const store = createStore(src, { identityName: 'Test Author' });   // v1
      // Every version starts with an empty published list.
      assert.deepEqual(store.readHistory().versions[0].published, []);
      const rec = {
        access: 'personal',
        sharedWithEmails: ['a@x.com', 'b@x.com'],
        sharedWithGroups: [],
        viewerUrl: 'https://devrev-artifact-viewer.vercel.app/?artifact=abc',
        publicUrl: null,
        expiresAt: null,
        publishedAt: '2026-06-05T10:00:00.000Z',
      };
      const v = store.recordPublish(1, rec);
      assert.equal(v.published.length, 1);
      assert.equal(v.published[0].access, 'personal');
      assert.deepEqual(v.published[0].sharedWithEmails, ['a@x.com', 'b@x.com']);
      // Persisted + visible via a fresh read.
      const reread = createStore(src, { identityName: 'Test Author' }).readHistory();
      assert.equal(reread.versions.find((x) => x.n === 1).published[0].viewerUrl,
        'https://devrev-artifact-viewer.vercel.app/?artifact=abc');
    } finally { cleanup(dir); }
  });

  test(`[${label}] commitIfChanged commits when source changed, skips when identical`, () => {
    const { dir, src } = setup();
    try {
      const store = createStore(src, { identityName: 'Test Author' });   // v1
      // No edit yet -> no new version.
      assert.equal(store.commitIfChanged('rebuild'), null);
      assert.equal(store.readHistory().versions.length, 1);
      // Edit -> exactly one new version.
      writeFileSync(src, '<h1>changed</h1>', 'utf8');
      const v = store.commitIfChanged('Updated page');
      assert.ok(v && v.n === 2);
      assert.equal(store.readHistory().versions.length, 2);
      // Rebuild again with no further edit -> still 2 (no phantom version).
      assert.equal(store.commitIfChanged('rebuild'), null);
      assert.equal(store.readHistory().versions.length, 2);
    } finally { cleanup(dir); }
  });

  test(`[${label}] restore writes exact old content as a NEW forward version`, () => {
    const { dir, src } = setup();
    try {
      const store = createStore(src, { identityName: 'Test Author' });   // v1 = "<h1>v1</h1>"
      writeFileSync(src, '<h1>v2</h1>', 'utf8');
      store.commit('Second');                                             // v2
      const restored = store.restore(1);                                  // v3 == content of v1
      assert.equal(restored.n, 3);
      assert.equal(restored.isRestore, true);
      assert.equal(restored.restoredFrom, 1);
      assert.equal(readFileSync(src, 'utf8'), '<h1>v1</h1>');             // byte-for-byte
      const h = store.readHistory();
      assert.equal(h.versions.length, 3);                                 // nothing lost
      assert.equal(h.versions[0].n, 3);
    } finally { cleanup(dir); }
  });

  test(`[${label}] branch creates an isolated timeline and switches to it`, () => {
    const { dir, src } = setup();
    try {
      const store = createStore(src, { identityName: 'Test Author' });   // v1 on main
      writeFileSync(src, '<h1>v2</h1>', 'utf8');
      store.commit('Second on main');                                     // v2 on main
      store.branch('experiment', 1);                                      // branch from v1
      let h = store.readHistory();
      assert.equal(h.currentBranch, 'experiment');
      assert.ok(h.branches.includes('experiment'));
      assert.ok(h.branches.includes('main'));
      assert.equal(h.versions.length, 1);                                 // only v1 carried over
      writeFileSync(src, '<h1>exp</h1>', 'utf8');
      store.commit('Experiment change');
      h = store.readHistory();
      assert.equal(h.versions.length, 2);
      store.switchBranch('main');
      h = store.readHistory();
      assert.equal(h.currentBranch, 'main');
      assert.equal(h.versions.length, 2);                                 // main untouched
    } finally { cleanup(dir); }
  });

  test(`[${label}] readHistory is stable across a fresh handle (persisted)`, () => {
    const { dir, src } = setup();
    try {
      createStore(src, { identityName: 'Test Author' });
      const reopened = createStore(src, { identityName: 'Test Author' }); // idempotent
      const h = reopened.readHistory();
      assert.equal(h.versions.length, 1);                                  // did not re-seed
    } finally { cleanup(dir); }
  });
}
