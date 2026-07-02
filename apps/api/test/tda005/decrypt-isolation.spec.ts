/**
 * TDA-005 Task 6 — decrypt-grant isolation (source scan).
 *
 * Proves the KMS *unwrap* grant is isolated: the only files in apps/api/src that
 * INVOKE `.unwrapKey(` are the CredentialDecryptor (the sole decrypt-for-execution
 * boundary) and the credential re-wrap job (Task 7). The write side uses
 * generateDataKey/wrapKey only, so connect and decrypt are separable IAM grants.
 *
 * (KMS provider/interface files DECLARE `unwrapKey(` but never invoke it via a
 * receiver `.unwrapKey(`, so the dotted-call pattern excludes them cleanly.)
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

/** Recursively collect all .ts files under `dir`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const ALLOWED = [
  path.join('credential-vault', 'execution', 'credential-decryptor.ts'),
  path.join('credential-vault', 'jobs', 'credential-rewrap.job.ts'),
];

describe('decrypt-grant isolation', () => {
  const files = walk(SRC);
  const callers = files.filter((f) => /\.unwrapKey\(/.test(fs.readFileSync(f, 'utf8')));
  const rel = callers.map((f) => path.relative(SRC, f).replace(/\\/g, path.sep));

  it('every .unwrapKey() caller is in the allowed (isolated) set', () => {
    const stray = rel.filter((r) => !ALLOWED.some((a) => r.endsWith(a)));
    expect(stray).toEqual([]);
  });

  it('the CredentialDecryptor is (at least) one of the unwrap callers', () => {
    expect(rel.some((r) => r.endsWith(ALLOWED[0]))).toBe(true);
  });
});
