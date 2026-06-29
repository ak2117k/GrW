// Side-effect module — MUST be imported before any other app module.
//
// The repo-root `.env` holds JWT_SECRET + DATABASE_URL, but nest runs with cwd
// = apps/api (whose own `.env` lacks JWT_SECRET). auth.module reads
// `process.env.JWT_SECRET` at import time (static JwtModule.register / JWT
// strategy), so without loading the root .env first the app intermittently
// crashes on rebuild with "JwtStrategy requires a secret or key".
//
// dotenv.config() does NOT override already-set vars, so root-first then local
// gives root values precedence while still picking up any apps/api-only keys.
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '../../.env') }); // repo root
dotenv.config(); // apps/api/.env (fills gaps, never overrides)
