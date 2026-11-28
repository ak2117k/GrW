/**
 * Which sentinel_verdicts rows are the TRADE AGENT's own look, and how an agent EXIT is written on an alarm. Pure.
 *
 * Only the live sentinel judge answers an alarm. Its stamp is the composite prompt version
 * (trade-sentinel/prompts/sentinel-system-prompt.ts sentinelCompositePromptVersion): `v<n>[.<m>]` + optional
 * `+<letter><n>` suffixes (incl. the authority's `+x1`) + `/t<n>` (the thesis prompt), e.g. `v9+l1+d1+e1+s1+a1+x1/t2`.
 * Everything else that writes sentinel_verdicts is NOT an agent look and must never answer an alarm or count as the
 * agent's last verdict: code-rule stamps (`rule:…`), the desk manager's TIGHTEN rows (`desk-manager/1`), the signal
 * trader's SL rows (`signal-trader-v1`), the overnight review (`o4/t2`, no alarm section), anything unknown.
 * A whitelist on purpose: a new non-agent writer is excluded by default (stamps.contract.spec pins the family).
 */
const SENTINEL_JUDGE_STAMP = /^v\d+(?:\.\d+)?(?:\+[a-z]\d+)*\/t\d+$/;

/** The prefix every sentinel judge stamp starts with (a cheap DB pre-filter; the regex decides). */
export const SENTINEL_JUDGE_STAMP_PREFIX = 'v';

export const isAgentVerdictStamp = (promptVersion: string | null | undefined): boolean =>
  typeof promptVersion === 'string' && SENTINEL_JUDGE_STAMP.test(promptVersion);

/** The verdict word an agent exit is stored under on an alarm's `answer` (the sentinel's own verdict word). */
export const EXIT_ANSWER = 'EXIT_NOW';

/** The alarm `answer` for an agent exit, with a note: `EXIT_NOW (supreme asked)`. */
export const exitAnswer = (note: string): string => `${EXIT_ANSWER} (${note})`;

/** True when an alarm answer / verdict is an agent exit (EXIT_NOW, with or without a note). */
export const isExitAnswer = (v: string | null | undefined): boolean => /^EXIT_NOW\b/i.test(String(v ?? '').trim());

/**
 * The verdict word an EXIT_NOW is stored under when it must never reach the executor (a held position, an authority
 * drill look): the executor polls `verdict = 'EXIT_NOW'` only. Re-exported by trade-sentinel judge-gate.
 */
export const ADVISORY_VERDICT = 'EXIT_ADVISORY';
