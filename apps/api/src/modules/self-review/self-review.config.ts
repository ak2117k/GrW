/** SELF_REVIEW_ENABLED (default true): off only for the exact words false|off|0. */
export interface SelfReviewConfig {
  enabled: boolean;
}

export const SELF_REVIEW_CONFIG = Symbol('SELF_REVIEW_CONFIG');

export function parseSelfReviewConfig(env: Record<string, string | undefined>): SelfReviewConfig {
  const raw = (env.SELF_REVIEW_ENABLED ?? '').trim().toLowerCase();
  return { enabled: !(raw === 'false' || raw === 'off' || raw === '0') };
}
