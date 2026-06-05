import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createGitStore } from './git-store.mjs';
import { runStoreContract } from './store-contract.mjs';

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); }
catch { gitAvailable = false; }

if (gitAvailable) {
  runStoreContract('GitStore', createGitStore);
} else {
  test('[GitStore] skipped — git not installed', { skip: true }, () => {});
}
