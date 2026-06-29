/**
 * Pure, case-insensitive "hull" substring test for a Chartink scanner name.
 *
 * The candle-replay / scanner-attribution research found the ungated track's
 * profit is concentrated in the `Anand 100Hull >200 hull` scanner while the
 * other scanners collectively bleed. The ungated entry gate uses this helper to
 * admit ONLY Hull-scanner signals. The substring match (rather than an exact
 * name) is robust to renames / future Hull variants; no other current scanner
 * contains "hull".
 *
 * @returns true when `name` contains "hull" (any case); false for null/empty.
 */
export function isHullScanner(name: string | null): boolean {
  if (!name) return false;
  return name.toLowerCase().includes('hull');
}
