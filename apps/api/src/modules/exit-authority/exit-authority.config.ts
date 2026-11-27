/**
 * TRADE_AGENT_AUTHORITY=off|live. Default off; anything unrecognised is off. `live` is only the requested
 * mode: AuthorityStateService (boot check) decides the effective mode.
 */
export type AuthorityMode = 'off' | 'live';

export function parseAuthorityMode(env: Record<string, string | undefined>): AuthorityMode {
  const raw = (env.TRADE_AGENT_AUTHORITY ?? '').trim().toLowerCase();
  return raw === 'live' ? 'live' : 'off';
}
