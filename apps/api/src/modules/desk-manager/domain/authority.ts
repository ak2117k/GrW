import type { AuthorityStatePort } from '../../exit-authority/exit-authority.tokens';

/**
 * Trade agent exit authority on for the desk manager? Only an injected AUTHORITY_STATE that says live counts:
 * absent, throwing or not live ⇒ off (today's behaviour).
 */
export function authorityLive(state: AuthorityStatePort | null | undefined): boolean {
  if (!state) return false;
  try {
    return state.isLive() === true;
  } catch {
    return false;
  }
}
