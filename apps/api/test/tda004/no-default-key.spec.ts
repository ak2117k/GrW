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
 *
 * One production file is allowlisted: `common/config/validate-boot-config.ts`
 * (TDA-004 Task 4) names the sentinel precisely to REJECT it at boot — it is the
 * enforcement site that bans the value, not a fallback that uses it. The guard's
 * intent is "no file uses the sentinel as a usable default key", which that file
 * does not; flagging the ban-site would be a false positive.
 */
const SENTINEL = ['td-automation', 'default-key', 'change-me'].join('-');
const SRC_ROOT = path.resolve(__dirname, '../../src');

// Files permitted to mention the sentinel because they enforce against it
// rather than use it as a default. Compared by normalized absolute path.
const ALLOWED = new Set([
  path.resolve(SRC_ROOT, 'common/config/validate-boot-config.ts'),
]);

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
    const offenders = collectTsFiles(SRC_ROOT).filter(
      (file) =>
        !ALLOWED.has(path.resolve(file)) &&
        fs.readFileSync(file, 'utf8').includes(SENTINEL),
    );
    expect(offenders).toEqual([]);
  });
});
