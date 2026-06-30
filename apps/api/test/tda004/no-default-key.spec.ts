import * as fs from 'fs';
import * as path from 'path';

/**
 * Repo-wide regression guard (TDA-004 Task 8).
 *
 * Task 2 deleted the public default-key sentinel
 * `td-automation-default-key-change-me` from production source. This test walks
 * every `*.ts` file under `apps/api/src` and fails if the sentinel reappears —
 * locking the removal in forever.
 *
 * Scope is `src/**` ONLY. The sentinel string legitimately appears in test files
 * (this spec and encryption-key.spec.ts's `.not.toContain` guard), so walking
 * test/ would self-trip. We check production source exactly as the brief intends.
 */
const SENTINEL = ['td-automation', 'default-key', 'change-me'].join('-');
const SRC_ROOT = path.resolve(__dirname, '../../src');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('default-key regression guard', () => {
  it('no file under apps/api/src contains the default-key sentinel', () => {
    const offenders = collectTsFiles(SRC_ROOT).filter((file) =>
      fs.readFileSync(file, 'utf8').includes(SENTINEL),
    );
    expect(offenders).toEqual([]);
  });
});
