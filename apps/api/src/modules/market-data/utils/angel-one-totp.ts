import * as crypto from 'crypto';

/**
 * Generate a 6-digit TOTP code from a base32 secret using Node crypto.
 * Standard RFC 6238 implementation (SHA-1, 30-second period, 6 digits).
 *
 * Extracted from `angel-one-auth.service.ts` so the live login (market-data
 * singleton) and the per-user ephemeral `AngelOneValidator` (TDA-005) produce
 * codes identically. Behaviour is byte-for-byte unchanged.
 */
export function generateTOTP(base32Secret: string): string {
  // Decode base32
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of base32Secret.toUpperCase().replace(/=+$/g, '')) {
    const val = base32chars.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  const key = Buffer.from(bytes);

  // Time counter (30-second periods)
  const time = Math.floor(Date.now() / 1000 / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(time / 0x100000000), 0);
  timeBuffer.writeUInt32BE(time & 0xffffffff, 4);

  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', key).update(timeBuffer).digest();

  // Dynamic truncation
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    1_000_000;

  return code.toString().padStart(6, '0');
}
