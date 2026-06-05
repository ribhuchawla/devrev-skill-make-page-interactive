// Pure-Node snapshot backend. No git required. Mirrors git semantics:
// linear append-only history, forward-restore, named branches. Persists to a
// hidden sibling dir `.<page>.versions/` with a manifest.json + snapshots/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { shortHash } from './hashing.mjs';

const COMPUTER_AUTHOR = 'Computer';

function storeDirFor(sourcePath) {
  return join(dirname(sourcePath), `.${basename(sourcePath)}.versions`);
}

function loadManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}
function saveManifest(dir, m) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8');
}

export function createFileStore(sourcePath, { identityName } = {}) {
  const dir = storeDirFor(sourcePath);
  const snaps = join(dir, 'snapshots');
  const page = basename(sourcePath);

  if (!existsSync(dir)) {
    mkdirSync(snaps, { recursive: true });
    const content = readFileSync(sourcePath, 'utf8');
    const hash = shortHash(content);
    writeFileSync(join(snaps, `1-${hash}.html`), content, 'utf8');
    const manifest = {
      page,
      identityName: identityName || null,
      currentBranch: 'main',
      branches: {
        main: [{
          n: 1, hash, title: 'Initial version', body: [], published: [], author: COMPUTER_AUTHOR,
          isoTime: new Date().toISOString(), isRestore: false, restoredFrom: null,
          file: `1-${hash}.html`,
        }],
      },
    };
    saveManifest(dir, manifest);
  } else if (identityName) {
    const m = loadManifest(dir);
    if (!m.identityName) { m.identityName = identityName; saveManifest(dir, m); }
  }

  const handle = {
    commit(title, opts = {}) {
      const m = loadManifest(dir);
      const branch = m.branches[m.currentBranch];
      const content = readFileSync(sourcePath, 'utf8');
      const hash = shortHash(content);
      const n = branch.length + 1;
      const file = `${n}-${hash}.html`;
      writeFileSync(join(snaps, file), content, 'utf8');
      const version = {
        n, hash, title,
        body: Array.isArray(opts.body) ? opts.body.filter(Boolean) : [],
        published: [],
        author: opts.author || m.identityName || COMPUTER_AUTHOR,
        isoTime: new Date().toISOString(),
        isRestore: !!opts.isRestore,
        restoredFrom: opts.restoredFrom ?? null,
        file,
      };
      branch.push(version);
      saveManifest(dir, m);
      return stripFile(version);
    },

    // Commit only if the current source content differs from the latest version
    // on the current branch. Returns the new Version, or null if unchanged.
    // This is what guarantees a version per real edit on every rebuild.
    commitIfChanged(title, opts = {}) {
      const m = loadManifest(dir);
      const branch = m.branches[m.currentBranch];
      const latest = branch[branch.length - 1];
      const hash = shortHash(readFileSync(sourcePath, 'utf8'));
      if (latest && latest.hash === hash) return null;
      return handle.commit(title, opts);
    },

    // Append a publish record to version n's published[]. Returns the version.
    recordPublish(n, record) {
      const m = loadManifest(dir);
      const branch = m.branches[m.currentBranch];
      const target = branch.find((v) => v.n === n);
      if (!target) throw new Error(`version ${n} not found on ${m.currentBranch}`);
      if (!Array.isArray(target.published)) target.published = [];
      target.published.push(record);
      saveManifest(dir, m);
      return stripFile(target);
    },

    restore(n) {
      const m = loadManifest(dir);
      const branch = m.branches[m.currentBranch];
      const target = branch.find((v) => v.n === n);
      if (!target) throw new Error(`version ${n} not found on ${m.currentBranch}`);
      const content = readFileSync(join(snaps, target.file), 'utf8');
      writeFileSync(sourcePath, content, 'utf8');
      return handle.commit(`Restore v${n}: ${target.title}`, { isRestore: true, restoredFrom: n });
    },

    branch(name, fromN) {
      const m = loadManifest(dir);
      if (m.branches[name]) throw new Error(`branch "${name}" already exists`);
      const src = m.branches[m.currentBranch];
      const carried = src.filter((v) => v.n <= fromN).map((v) => ({ ...v }));
      if (carried.length === 0) throw new Error(`version ${fromN} not found`);
      m.branches[name] = carried;
      m.currentBranch = name;
      saveManifest(dir, m);
    },

    switchBranch(name) {
      const m = loadManifest(dir);
      if (!m.branches[name]) throw new Error(`branch "${name}" not found`);
      m.currentBranch = name;
      saveManifest(dir, m);
      // Make the working source reflect the tip of the switched-to branch.
      const tip = m.branches[name][m.branches[name].length - 1];
      writeFileSync(sourcePath, readFileSync(join(snaps, tip.file), 'utf8'), 'utf8');
    },

    readHistory() {
      const m = loadManifest(dir);
      const branch = m.branches[m.currentBranch];
      const versions = branch.map((v) => {
        const s = stripFile(v);
        if (!Array.isArray(s.published)) s.published = [];
        return s;
      }).slice().reverse(); // newest first
      return {
        page: m.page,
        currentBranch: m.currentBranch,
        branches: Object.keys(m.branches),
        currentCommit: versions[0]?.hash ?? '',
        versions,
      };
    },
  };
  return handle;
}

function stripFile(v) {
  const { file, ...rest } = v; // `file` is a storage detail, not part of the contract shape
  return rest;
}
