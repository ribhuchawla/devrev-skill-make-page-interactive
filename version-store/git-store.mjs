// Real-git backend. Tracks a single `source.html` inside a hidden sibling repo
// `.<page>.versions/`. Restore metadata is persisted via a `restored-from:`
// commit trailer and parsed back out in readHistory. Identity is configured
// LOCALLY in the repo (never global); the seed commit is authored "Computer".
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const COMPUTER_AUTHOR = 'Computer';
const COMPUTER_EMAIL = 'computer@devrev.local';
const US = '\x1f'; // field sep
const RS = '\x1e'; // record sep

function storeDirFor(sourcePath) {
  return join(dirname(sourcePath), `.${basename(sourcePath)}.versions`);
}

export function createGitStore(sourcePath, { identityName } = {}) {
  const dir = storeDirFor(sourcePath);
  const tracked = join(dir, 'source.html');
  const page = basename(sourcePath);
  const git = (args, opts = {}) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', ...opts });

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    git(['init', '-q', '-b', 'main']);
    const name = identityName || COMPUTER_AUTHOR;
    git(['config', 'user.name', name]);
    git(['config', 'user.email', 'page-author@devrev.local']);
    writeFileSync(tracked, readFileSync(sourcePath, 'utf8'), 'utf8');
    git(['add', 'source.html']);
    // Seed commit is always authored "Computer".
    git(['commit', '-q', '-m', 'Initial version',
      `--author=${COMPUTER_AUTHOR} <${COMPUTER_EMAIL}>`]);
  } else if (identityName) {
    let cur = '';
    try { cur = git(['config', 'user.name']).trim(); } catch { /* unset */ }
    if (!cur) {
      git(['config', 'user.name', identityName]);
      git(['config', 'user.email', 'page-author@devrev.local']);
    }
  }

  const currentBranch = () => git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();

  // Read the publishes note (JSON array) for a full commit hash; [] if none.
  // "no note found" is the normal case for unpublished versions, so swallow
  // git's stderr (stdio pipe) instead of letting it leak to the console.
  const readPublishNote = (full) => {
    try {
      return JSON.parse(git(['notes', '--ref', 'publishes', 'show', full],
        { stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch { return []; }
  };

  const handle = {
    commit(title, opts = {}) {
      writeFileSync(tracked, readFileSync(sourcePath, 'utf8'), 'utf8');
      git(['add', 'source.html']);
      // Body carries change bullets as "- " lines (shown in the picker hover)
      // plus an optional restored-from trailer.
      const bullets = (Array.isArray(opts.body) ? opts.body.filter(Boolean) : [])
        .map((b) => `- ${b}`);
      const bodyLines = bullets.slice();
      if (opts.restoredFrom != null) bodyLines.push(`restored-from: ${opts.restoredFrom}`);
      const msg = bodyLines.length ? `${title}\n\n${bodyLines.join('\n')}` : title;
      const args = ['commit', '-q', '-m', msg, '--allow-empty'];
      if (opts.author) args.push(`--author=${opts.author} <page-author@devrev.local>`);
      git(args);
      const h = handle.readHistory();
      return h.versions[0];
    },

    // Commit only if the current source differs from the latest committed
    // version. Returns the new Version, or null if unchanged. Guarantees a
    // version per real edit on every rebuild.
    commitIfChanged(title, opts = {}) {
      writeFileSync(tracked, readFileSync(sourcePath, 'utf8'), 'utf8');
      git(['add', 'source.html']);
      // Exit code 1 from `diff --cached --quiet` means staged changes exist.
      let changed = false;
      try { git(['diff', '--cached', '--quiet']); } catch { changed = true; }
      if (!changed) return null;
      return handle.commit(title, opts);
    },

    restore(n) {
      const h = handle.readHistory();
      const target = h.versions.find((v) => v.n === n);
      if (!target) throw new Error(`version ${n} not found on ${h.currentBranch}`);
      const content = git(['show', `${target.hash}:source.html`]);
      writeFileSync(sourcePath, content, 'utf8');
      return handle.commit(`Restore v${n}: ${target.title}`, { restoredFrom: n });
    },

    branch(name, fromN) {
      const h = handle.readHistory();
      const target = h.versions.find((v) => v.n === fromN);
      if (!target) throw new Error(`version ${fromN} not found`);
      git(['branch', name, target.hash]);
      git(['switch', '-q', name]);
      writeFileSync(sourcePath, git(['show', 'HEAD:source.html']), 'utf8');
    },

    switchBranch(name) {
      git(['switch', '-q', name]);
      writeFileSync(sourcePath, git(['show', 'HEAD:source.html']), 'utf8');
    },

    // Publish records can't live in the (immutable) commit, so attach them as a
    // git note (ref refs/notes/publishes) keyed by commit hash: a JSON array.
    recordPublish(n, record) {
      const h = handle.readHistory();
      const target = h.versions.find((v) => v.n === n);
      if (!target) throw new Error(`version ${n} not found on ${h.currentBranch}`);
      const full = git(['rev-parse', target.hash]).trim();
      const arr = readPublishNote(full);
      arr.push(record);
      git(['notes', '--ref', 'publishes', 'add', '-f', '-m', JSON.stringify(arr), full]);
      return { ...target, published: arr };
    },

    readHistory() {
      const branch = currentBranch();
      const fmt = ['%H', '%an', '%aI', '%s', '%b'].join(US) + RS;
      const raw = git(['log', `--pretty=format:${fmt}`, branch]);
      const records = raw.split(RS).map((r) => r.trim()).filter(Boolean);
      // git log is newest-first; assign n oldest=1 by counting from the end.
      const total = records.length;
      const versions = records.map((rec, i) => {
        const [full, author, isoTime, title, body = ''] = rec.split(US);
        const m = body.match(/restored-from:\s*(\d+)/);
        const bulletLines = body.split('\n')
          .map((s) => s.trim())
          .filter((s) => s.startsWith('- '))
          .map((s) => s.slice(2).trim());
        return {
          n: total - i,
          hash: full.slice(0, 7),
          title: (title || '').trim(),
          body: bulletLines,
          published: readPublishNote(full),
          author: author.trim(),
          isoTime: isoTime.trim(),
          isRestore: !!m,
          restoredFrom: m ? Number(m[1]) : null,
        };
      });
      const branches = git(['branch', '--format=%(refname:short)'])
        .split('\n').map((s) => s.trim()).filter(Boolean);
      return {
        page,
        currentBranch: branch,
        branches,
        currentCommit: versions[0]?.hash ?? '',
        versions,
      };
    },
  };
  return handle;
}
