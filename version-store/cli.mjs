// Agent-facing mutation CLI. Usage:
//   node cli.mjs commit  <source.html> "<title>"
//   node cli.mjs restore <source.html> <n>
//   node cli.mjs branch  <source.html> <name> <fromN>
//   node cli.mjs switch  <source.html> <name>
//   node cli.mjs history <source.html>            (prints History JSON)
import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveStore } from './detect.mjs';

/** Best-effort author identity: git global user.name, else null (store seeds "Computer"/identity). */
function resolveIdentityName() {
  try {
    const n = execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim();
    if (n) return n;
  } catch { /* git absent or unset */ }
  return null;
}

/** Run the CLI with an argv array (no process exit on the happy path). Returns stdout string for `history`. */
export function runCli(argv) {
  const [cmd, sourcePath, a, b] = argv;
  if (!cmd || !sourcePath) throw new Error('usage: <commit|restore|branch|switch|history> <source.html> [...]');

  const createStore = resolveStore();
  const store = createStore(sourcePath, { identityName: resolveIdentityName() });

  switch (cmd) {
    case 'commit': {
      if (!a) throw new Error('commit requires a title');
      // Optional change bullets: --bullet "Removed decimals" --bullet "Recoloured metric"
      const rest = argv.slice(3);
      const body = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--bullet' && rest[i + 1] != null) { body.push(rest[++i]); }
      }
      const v = store.commit(a, { body });
      return JSON.stringify(v);
    }
    case 'restore': {
      const v = store.restore(Number(a));
      return JSON.stringify(v);
    }
    case 'branch': {
      if (!a || b == null) throw new Error('branch requires <name> <fromN>');
      store.branch(a, Number(b));
      return JSON.stringify(store.readHistory());
    }
    case 'switch': {
      if (!a) throw new Error('switch requires <name>');
      store.switchBranch(a);
      return JSON.stringify(store.readHistory());
    }
    case 'record-publish': {
      if (!a) throw new Error('record-publish requires <n>');
      // argv = [cmd, source, n, ...flags] — flags begin at index 3.
      const rest = argv.slice(3);
      const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
      const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
      const record = {
        access: flag('--access') || 'internal',
        sharedWithEmails: csv(flag('--emails')),
        sharedWithGroups: csv(flag('--groups')),
        viewerUrl: flag('--viewer-url') || null,
        publicUrl: flag('--public-url') || null,
        expiresAt: flag('--expires-at') || null,
        publishedAt: flag('--at') || '1970-01-01T00:00:00.000Z',
      };
      const v = store.recordPublish(Number(a), record);
      return JSON.stringify(v);
    }
    case 'history':
      return JSON.stringify(store.readHistory(), null, 2);
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

// Direct invocation. Compare resolved real paths (NOT raw string interpolation):
// import.meta.url is percent-encoded while argv[1] is a raw path, so paths with
// spaces (e.g. "Ribhu's Computer") would never match a `file://${argv[1]}` check.
function isMain() {
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const out = runCli(argv.slice(2));
    if (out) console.log(out);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
