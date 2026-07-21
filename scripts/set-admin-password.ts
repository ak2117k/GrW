/**
 * Bootstrap / reset the seeded ADMIN account's password.
 *
 * The DB seed (prisma/seed.ts) creates `admin@local` with an INERT placeholder
 * hash (`!UNSET-SET-IN-TDA-002`) so no default credential ever ships in git.
 * Run this ONCE PER ENVIRONMENT to set a real argon2id password, then log in as
 * admin@local to reach the admin-only surfaces (e.g. the Telegram Signals section).
 *
 * Usage (never hardcode the password — pass it via env):
 *   ADMIN_BOOTSTRAP_PASSWORD='Your-Strong-Passw0rd!' npx tsx scripts/set-admin-password.ts
 *   # or, once the npm alias is added:  npm run admin:set-password
 *
 * Optional:
 *   ADMIN_BOOTSTRAP_EMAIL   target a different EXISTING user (default: admin@local)
 *
 * Requires DATABASE_URL in the environment (point it at the target DB — local or
 * Neon). apps/api/.env and root .env are auto-loaded when `dotenv` is available.
 *
 * Idempotent: re-running just re-sets the password. The password is never logged.
 * Hashing + strength rules are taken from the app's own PasswordService, so the
 * resulting credential is identical to one set via the normal signup/reset flow.
 */
import { PrismaClient } from '@prisma/client';
import { PasswordService } from '../apps/api/src/modules/auth/services/password.service';

// Best-effort .env load — prisma auto-loads it for `db:seed`, but a bare
// `tsx scripts/...` invocation does not. Never overrides already-set vars.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dotenv = require('dotenv') as typeof import('dotenv');
  dotenv.config({ path: 'apps/api/.env' });
  dotenv.config();
} catch {
  /* dotenv not installed — rely on the ambient environment */
}

async function main(): Promise<void> {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL ?? 'admin@local';
  const plain = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (!plain) {
    throw new Error('ADMIN_BOOTSTRAP_PASSWORD is not set. Provide it via env (never hardcode).');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Point it at the target DB (local or Neon) before running.');
  }

  // Enforce the SAME 8–128 length / 3-of-4 character-class rules as signup/reset,
  // then hash with the SAME argon2id params — so this credential is app-identical.
  const passwords = new PasswordService();
  passwords.assertStrength(plain);
  const passwordHash = await passwords.hash(plain);

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!existing) {
      throw new Error(
        `No user with email "${email}" exists. Run the DB seed first (npm run db:seed), ` +
          'or set ADMIN_BOOTSTRAP_EMAIL to an existing user.',
      );
    }
    const user = await prisma.user.update({
      where: { email },
      data: { passwordHash, role: 'ADMIN', status: 'ACTIVE' },
      select: { id: true, email: true, role: true, status: true },
    });
    console.log(`✓ Password set for ${user.email} (id=${user.id}, role=${user.role}, status=${user.status}).`);
    console.log('  Log in with this email and the password you provided. Delete the env var from your shell history afterwards.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
