// Backend selection ladder (spec §4): git present -> git; git absent but brew
// present -> silent `brew install git` -> git; neither -> file store. NEVER
// triggers Homebrew bootstrap or the xcode-select GUI installer.
import { execFileSync } from 'node:child_process';
import { createGitStore } from './git-store.mjs';
import { createFileStore } from './file-store.mjs';

const probes = {
  hasGit: () => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } },
  hasBrew: () => { try { execFileSync('brew', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } },
  install: () => { try { execFileSync('brew', ['install', 'git'], { stdio: 'ignore' }); } catch { /* best effort */ } },
};

/** Pure decision (injectable probes) -> 'git' | 'file'. */
export function chooseBackend(p = probes) {
  if (p.hasGit()) return 'git';
  if (p.hasBrew()) {
    p.install();
    if (p.hasGit()) return 'git';
  }
  return 'file';
}

/** Resolve the concrete store factory for a source path. Logs the choice. */
export function resolveStore() {
  const backend = chooseBackend();
  if (backend === 'file') {
    console.error('[versioning] git unavailable — using built-in snapshot store. ' +
      'For full git history, run: xcode-select --install');
  }
  return backend === 'git' ? createGitStore : createFileStore;
}
