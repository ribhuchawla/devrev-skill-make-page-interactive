import { createHash } from 'node:crypto';

/** Short content hash, mirrors a git short SHA for display parity. */
export function shortHash(content) {
  return createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 7);
}
