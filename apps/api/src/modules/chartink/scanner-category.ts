/** Swing dual-track scanners. `chartink-process.service.ts` fires the ANAND dual
 *  track only when a scanner's category equals this. */
export const ANAND_SWING = 'ANAND_SWING';

/** Default for everything else. Matches the Prisma schema default. */
export const OTHER = 'OTHER';

/**
 * Derive a scanner's category from its Chartink scan name.
 *
 * Scanner rows default to OTHER and are otherwise only categorised by an explicit
 * admin action — so a scanner named "ANAND SWING …" silently ran as a non-swing
 * scanner and never took the swing track (it fired 345 times in prod for zero
 * swing entries). Tagging from the name at creation removes that manual step.
 *
 * Match rule: the name contains the words "ANAND SWING" (case-insensitive, any
 * internal spacing). Deliberately requires BOTH words — "ANAND 200% PROFIT" and a
 * generic "SWING TRADES" are not the swing track and must stay OTHER. Total:
 * never throws, unknown/empty → OTHER.
 */
export function categorizeScannerByName(scanName: string): string {
  if (typeof scanName !== 'string') return OTHER;
  // Collapse internal whitespace so "ANAND   SWING" matches "ANAND SWING".
  const normalized = scanName.trim().replace(/\s+/g, ' ').toUpperCase();
  return normalized.includes('ANAND SWING') ? ANAND_SWING : OTHER;
}
