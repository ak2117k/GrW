/**
 * The one batched diagnosis call per self-review run: system prompt, user message builder
 * (with the contract's caps) and the strict reply validator. Pure — no I/O.
 */
import { clampText, isLessonKey, isLessonScope } from '../lessons/lessons.logic';
import { isAllowedTarget, TUNABLES } from '../tuning/tunables';
import { LESSON_SCOPES, LESSON_TEXT_MAX, type LessonRecord } from '../lessons/types';
import { FIX_CAUSES, MISS_CATEGORIES, type DiagnosedMiss, type FixCause, type MissCategory, type MissInput, type TicketProposal } from './types';

/** Bump when the prompt text or the schema changes; stored on the run's diagnosis. */
/** d6 (2026-11-02): SIGNAL_JUDGE / PAPER_EXIT / ENGINE_ENTRY misses; scopes SIGNAL_JUDGE and ENTRY_ENGINE. */
/** d7 (2026-11-02): PAPER_EXIT / LIVE_EXIT misses only when the exit was not justified (P(adverse) < 0.75); noiseReads.justification. */
/** d8 (2026-11-04): DECISION:<type> misses from the decision ledger; causeType + ticket per group; scopes THESIS and NEWS. */
/** d9 (2026-11-09): MISSED_MOVE misses: big F&O moves we did not have, and where the pipeline lost them. */
export const DIAGNOSIS_PROMPT_VERSION = 'd9';

/** At most this many misses go into one call (contract). */
export const MAX_MISSES = 15;
/** Output budget (contract: ≤ ~3k). */
export const DIAGNOSIS_MAX_TOKENS = 3000;
/**
 * Input budget: ~30k tokens. At ~4 chars a token, the user message is held under 100k
 * chars, leaving room for the system prompt.
 */
export const USER_MESSAGE_MAX_CHARS = 100_000;
/** Per-miss caps, halved until the message fits. */
const INPUTS_EXCERPT_MAX = 6000;
const DETAILS_EXCERPT_MAX = 1200;
const CAUSE_MAX = 500;
const MAX_ACTIVE_LESSONS_SHOWN = 30;
/** The entry engine assessment is clamped to this. */
export const ENGINE_ASSESSMENT_MAX = 1200;
/** Below this many CLOSED engine paper trades the assessment must say "insufficient sample" (domain/engine-trades ENGINE_MIN_SAMPLE). */
export const ENGINE_MIN_SAMPLE = 10;
/** The signal paper-trade assessment is clamped to this. */
export const PAPER_ASSESSMENT_MAX = 1200;
/** Below this many CLOSED trades in a bucket the assessment must say "insufficient sample". */
export const PAPER_MIN_SAMPLE = 10;
/** The exit noise assessment is clamped to this. */
export const NOISE_ASSESSMENT_MAX = 1200;
/** Below this many SCORED reads of a verdict the assessment must say "insufficient sample" (noise-score NOISE_SCORE.minSample). */
export const NOISE_MIN_SAMPLE = 10;

export const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['misses'],
  properties: {
    misses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['refIds', 'cause', 'category'],
        properties: {
          refIds: { type: 'array', items: { type: 'string' } },
          cause: { type: 'string' },
          category: { type: 'string', enum: [...MISS_CATEGORIES] },
          lessonKey: { type: 'string' },
          lessonText: { type: 'string' },
          scope: { type: 'string', enum: [...LESSON_SCOPES] },
          contradicts: { type: 'array', items: { type: 'string' } },
          blamedFactors: { type: 'array', items: { type: 'string' } },
          proposalTarget: { type: 'string' },
          proposedValue: { anyOf: [{ type: 'number' }, { type: 'boolean' }] },
          causeType: { type: 'string', enum: [...FIX_CAUSES] },
          ticket: {
            type: 'object',
            additionalProperties: false,
            required: ['title', 'proposedChange', 'files', 'testDescription'],
            properties: {
              title: { type: 'string' },
              proposedChange: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              testDescription: { type: 'string' },
            },
          },
        },
      },
    },
    signalPaperAssessment: { type: 'string' },
    exitNoiseAssessment: { type: 'string' },
    engineAssessment: { type: 'string' },
  },
} as const;

export const DIAGNOSIS_SYSTEM_PROMPT = [
  'You review the WRONG calls an automated trading assistant for the Indian market made in one session, after the outcome is known.',
  'Each miss has: kind (SCORECARD_TOTAL, SCORECARD_FACTOR, OVERNIGHT_VERDICT, LIVE_EXIT, NEWS_IDEA, TRADE_SETUP, MBM_PREDICTION, SIGNAL_JUDGE, PAPER_EXIT, ENGINE_ENTRY, MISSED_MOVE, DECISION:<type>), refId, symbol, what was predicted, what actually happened, a signed score where meaningful, and an excerpt of the inputs the call was made from.',
  'A TRADE_SETUP is a next-morning plan built mechanically from a news idea (details.newsIdea): the direction comes from the idea, the entry is details.entryRule (an opening-range break), the stop and T1 (1.5 R) come from the daily ATR (details.atr). Its score is the R realised. A miss is either the idea\'s direction (lesson scope NEWS_IDEAS) or the mechanical plan — entry rule, stop or target distance (a proposal, never a lesson that widens a stop).',
  'A SIGNAL_JUDGE miss is the Telegram-signal entry judge\'s TAKE / SKIP held against the FAIR check: the trade it could actually have taken — the cap-sized stop (details.capStop: entry ∓ caps.maxLossPerTrade per lot, never wider than the signal SL) replayed on the price path to T1 — made money after a SKIP, or lost after a TAKE. details carry the judge\'s reasons, skipKind (RISK_CAP = the decisive reason was the risk cap / sizing, JUDGEMENT = a market read), both stops\' outcomes and the path method. Its score is the ₹ of 1 lot on the cap-sized stop. Lessons for it use scope SIGNAL_JUDGE (the entry judge reads them). Never propose raising the risk cap; a RISK_CAP miss means the judge should judge the cap-sized stop on its noise distance instead of skipping on the cap alone.',
  'A PAPER_EXIT miss is an AI exit (AI_EXIT / AI_TRIGGER) or the noise-trail exit (MOVED_STOP) of a PAPER trade after which the underlying recovered ≥ 1 exit unit N in the trade\'s favour within 30 minutes (a premature exit). details carry favourN / againstN, N and its source, whether the exit noise read said NOISE, and the HELD follow (what holding on the trade\'s own rules made; score = ₹ holding beat the exit, else the recovery in N). Lessons for it use scope SENTINEL_LIVE (the same sentinel exit prompt runs paper and live).',
  'PAPER_EXIT and LIVE_EXIT misses follow the owner\'s rule: a recovered exit is a miss only when it was NOT justified — details.pAdverse (P that the position kept going against it, from the exit noise read\'s components and the news; details.pBasis heuristic-v1 is NOT calibrated, details.pParts lists each part) was below details.justifiedP (0.75), or could not be computed (null = counted as before). A justified exit the price recovered from anyway (outcome JUSTIFIED_UNLUCKY) is not a miss and never gets a lesson; noiseReads.justification counts them.',
  'An ENGINE_ENTRY miss is a closed entry-engine paper trade that lost (score = gross ₹). The engine is rule-based, not an LLM: give it no lesson unless the cause is a recurring rule problem (then scope ENTRY_ENGINE, shown to the owner only).',
  'A MISSED_MOVE miss is an F&O stock that moved at least 2 daily ATRs in the session that no engine put forward: we held nothing, real or paper, or only the owner found and traded it (OWNER_FOUND): predicted = how far it got in our pipeline, actual = the move, score = the move in ATRs, subject and details.cause = where it was lost (OWNER_FOUND, SETUP_NOT_TAKEN, IDEA_NOT_TAKEN, IDEA_REJECTED, SIGNAL_NOT_TAKEN, NEWS_NOT_READ, NEWS_READ_NOT_USED, NEWS_READ_LOW, MODEL_ONLY, NO_SIGNAL). Group these by cause and ask what in OUR process would have surfaced them. When the system already held the evidence and dropped it (news never read, a model flag nothing acted on, a strong read with no idea), use causeType CODE_BUG or DATA with a ticket naming the step to change. A move nothing knowable beforehand pointed to is NOISE: do not invent a reason. Judge what was knowable at the time; never use the move itself as the evidence.',
  'A DECISION:<type> miss comes from the decision ledger of the last 10 sessions: one decision the system made on a trade (ENTRY_TAKE, ENTRY_SKIP, ENTRY_BLOCKED, SIZE, EXIT, HOLD, GATED_EXIT, FLOOR, SPIKE_BANK, HARD_LOSS, LADDER, CARRY, CARRY_EXIT, THESIS) graded WRONG against the price path: predicted = what was chosen, actual = the alternative that was better, score = ₹ per lot net of charges the alternative beat it by (details: horizon, pnlChosen, pnlAlternative, reason, facts, mode live|paper). A DECISION:DETECTOR miss is a system failure, not a choice: details.detector LIVE_NOT_PLACED (a live call passed the gate but no broker order exists, grouped by blocker), INPUT_MISSING (a packet block absent / NO_DATA), EVENT_NO_ACTION (an event day with no action on an affected underlying), THESIS_CONTRADICTS_DATA (a stated thesis the stored bars contradict at that time). The same refId may repeat across nights; misses of earlier sessions are context for a pattern.',
  'You also get the lessons already in force (key, text, scope, right/wrong counts).',
  'For each miss, or group of misses with the same cause, return one entry:',
  '- refIds: the refIds it explains, copied exactly from the input.',
  '- cause: one or two sentences naming what in the inputs misled the call, or that the inputs could not have known (then category NOISE or DATA_MISSING).',
  `- category: one of ${MISS_CATEGORIES.join(', ')}.`,
  `- causeType: one of ${FIX_CAUSES.join(', ')}. DATA = an input was missing, stale or wrong; SETTING = a tunable threshold is off (then proposalTarget if one fits); REASONING = an AI's judgement or prompt was wrong (then a lesson); CODE_BUG = the code did something its own comment or spec says it should not (e.g. paper trades counted against a live limit, an order never placed); NOISE = the market did something no rule could know. Cite the evidence (refIds, numbers) in cause.`,
  '- ticket (only with causeType CODE_BUG or DATA): {title (one line naming the defect), proposedChange (the concrete change), files (repo paths you believe are involved, e.g. apps/api/src/modules/<module>/<file>.ts; [] when unknown — never invent), testDescription (the failing behaviour as a test name and expectation)}. A ticket is a request for a developer; it never changes code by itself.',
  '- lessonKey (optional): a lowercase-hyphenated slug (3–60 chars) for a lesson that, had it been followed, would have avoided these misses. REUSE an existing key when the same pattern recurs; invent a new key only for a genuinely new pattern.',
  `- lessonText (optional, required for a NEW key): one or two imperative sentences under ${LESSON_TEXT_MAX} characters, specific enough to act on (name the factor, window or condition).`,
  '- scope (optional): which agent the lesson is for — SENTINEL_LIVE (intraday exits, live and paper), SENTINEL_OVERNIGHT (overnight hold/exit verdicts), NEWS_IDEAS (news-driven trade ideas), SIGNAL_JUDGE (the Telegram-signal entry judge), ENTRY_ENGINE (the rule-based entry engine; owner only), THESIS (the sentinel\'s inferred-thesis step), NEWS (the news-impact reader), or ALL.',
  '- contradicts (optional): keys of EXISTING lessons that these misses followed, or would have followed, and that were therefore wrong here.',
  '- proposalTarget / proposedValue (optional): a tunable you suspect should change, e.g. scorecard.factor.news.weight 0.5. These are suggestions only; code decides.',
  'A SCORECARD_TOTAL miss carries details.factors: the signed points of every factor that was scored (the band comes from their sum). Blame only factors listed there with non-zero points; never name a factor that is absent or scored 0 (e.g. there is no index-trend factor).',
  '- blamedFactors (REQUIRED with a lessonKey or proposal on SCORECARD_TOTAL misses): the factor names, exactly as in details.factors, whose non-zero points caused the wrong band. A lesson or proposal whose blamed factors are missing, absent or zero on those misses is discarded by code.',
  `- proposalTarget must be one of: ${Object.keys(TUNABLES).join(', ')}. Anything else is discarded.`,
  'One session is one observation: several positions that went wrong on the same day for the same market reason are one case, not several.',
  'Rules: no lesson for NOISE; never a lesson or proposal that loosens a hard risk limit (max daily loss, position size, kill switch, stop or green floor); do not invent data that is not in the input; one miss may be left without a lesson.',
  `When the input has signalPaper (the Telegram-signal learning-mode paper trades, split by the OI check recorded at entry — AGREES / AGAINST / MIXED / NO_DATA — and by the AI entry judge's call TAKE / SKIP / NONE, for the session and the rolling 20 sessions, with the session's trades and each OI check's one-line reasoning), also return signalPaperAssessment: two to four plain sentences on whether the AGAINST trades underperformed the AGREES ones (win rate and GROSS ₹ of the closed trades — side × (exit − entry) × qty, see signalPaper.basis; the booked P&L is not used) and whether the judge's TAKEs beat its SKIPs. Name the numbers you used. When either compared bucket has fewer than ${PAPER_MIN_SAMPLE} closed trades in the rolling window, say "insufficient sample" and draw no conclusion. This is an observation for the owner, never a lesson or a proposal. Leave signalPaperAssessment out when there is no signalPaper.`,
  `When the input has noiseReads (a "noise or real?" read recorded at each AI exit — NOISE / REAL / MIXED / NO_DATA from the adverse move in noise units N, near-money option OI, futures OI with price, VWAP and volume — each NOISE / REAL read scored against the underlying's next 30 minutes, see noiseReads.basis, for the session and the rolling 20 sessions, with the session's reads and their one-line reasoning), also return exitNoiseAssessment: two to four plain sentences on how often NOISE reads were right (the exit was premature: the underlying recovered) and how often REAL reads were right (the move continued). Name the numbers you used (noiseRight / realRight are right/scored). When the rolling window has fewer than ${NOISE_MIN_SAMPLE} scored reads of a verdict, say "insufficient sample" for it and draw no conclusion. This is an observation for the owner, never a lesson or a proposal. Leave exitNoiseAssessment out when there is no noiseReads.`,
  `When the input has engine (the entry engine, stage 1: every 15 min per underlying it records ENTER_CE / ENTER_PE / NO_TRADE / WAIT — ENTER only when news, trend and OI all agree and the entry gates (15m MACD / EMA / RSI, not already extended in N15) pass; WAIT = they agreed but the price had already run, held for a pullback — and in paper mode opens an ENGINE_ENTRY paper trade; counts and GROSS ₹ of the closed engine trades for the session and the rolling 20 sessions, with the session's ENTER decisions and their reasons, see engine.basis), also return engineAssessment: two to four plain sentences on how often the engine entered, which component most often blocked an entry, and whether its closed paper trades made money (win rate and gross ₹). Name the numbers you used. When the rolling window has fewer than ${ENGINE_MIN_SAMPLE} closed engine trades, say "insufficient sample" for the P&L and draw no conclusion about it. This is an observation for the owner, never a lesson or a proposal. Leave engineAssessment out when there is no engine.`,
  'Answer ONLY with JSON: {"misses":[{"refIds","cause","category","causeType?","ticket?","lessonKey?","lessonText?","scope?","contradicts?","blamedFactors?","proposalTarget?","proposedValue?"}],"signalPaperAssessment?","exitNoiseAssessment?","engineAssessment?"}.',
].join('\n');

function excerpt(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return s.length <= max ? s : `${s.slice(0, max)}…[cut ${s.length - max} chars]`;
}

/** The misses actually sent: the cap keeps the largest |score| first (the costliest misses). */
export function capMisses(misses: readonly MissInput[], max = MAX_MISSES): { sent: MissInput[]; dropped: number } {
  const ranked = misses
    .map((m, i) => ({ m, i }))
    .sort((a, b) => Math.abs(b.m.score ?? 0) - Math.abs(a.m.score ?? 0) || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.m);
  return { sent: ranked, dropped: Math.max(0, misses.length - ranked.length) };
}

export function buildDiagnosisUserMessage(misses: readonly MissInput[], lessons: readonly LessonRecord[], signalPaper?: unknown, noiseReads?: unknown, engine?: unknown): string {
  const lessonList = lessons
    .filter((l) => l.status === 'ACTIVE')
    .slice(0, MAX_ACTIVE_LESSONS_SHOWN)
    .map((l) => ({ key: l.key, text: clampText(l.text), scope: l.scope, right: l.rightCount, wrong: l.wrongCount }));
  let inputsMax = INPUTS_EXCERPT_MAX;
  let detailsMax = DETAILS_EXCERPT_MAX;
  for (;;) {
    const msg = JSON.stringify({
      misses: misses.map((m) => ({
        kind: m.kind,
        refId: m.refId,
        session: m.sessionDate,
        symbol: m.symbol ?? undefined,
        subject: m.subject ?? undefined,
        predicted: excerpt(m.predicted, 400),
        actual: excerpt(m.actual, 400),
        score: m.score ?? undefined,
        details: excerpt(m.details, detailsMax),
        inputs: excerpt(m.inputs, inputsMax),
      })),
      activeLessons: lessonList,
      ...(signalPaper ? { signalPaper } : {}),
      ...(noiseReads ? { noiseReads } : {}),
      ...(engine ? { engine } : {}),
    });
    if (msg.length <= USER_MESSAGE_MAX_CHARS || inputsMax < 200) return msg.slice(0, USER_MESSAGE_MAX_CHARS);
    inputsMax = Math.floor(inputsMax / 2);
    detailsMax = Math.floor(detailsMax / 2);
  }
}

/** The reply's signal paper-trade assessment, trimmed and clamped; undefined when absent or empty. */
export function paperAssessmentOf(raw: unknown): string | undefined {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { signalPaperAssessment?: unknown }).signalPaperAssessment : undefined;
  return typeof a === 'string' && a.trim() !== '' ? clampText(a.trim(), PAPER_ASSESSMENT_MAX) : undefined;
}

/** The reply's exit noise assessment, trimmed and clamped; undefined when absent or empty. */
export function noiseAssessmentOf(raw: unknown): string | undefined {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { exitNoiseAssessment?: unknown }).exitNoiseAssessment : undefined;
  return typeof a === 'string' && a.trim() !== '' ? clampText(a.trim(), NOISE_ASSESSMENT_MAX) : undefined;
}

/** The reply's entry engine assessment, trimmed and clamped; undefined when absent or empty. */
export function engineAssessmentOf(raw: unknown): string | undefined {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { engineAssessment?: unknown }).engineAssessment : undefined;
  return typeof a === 'string' && a.trim() !== '' ? clampText(a.trim(), ENGINE_ASSESSMENT_MAX) : undefined;
}

/** Pull the first JSON object out of a reply (tolerates a ```json fence). */
export function extractJsonObject(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the reply');
  return JSON.parse(t.slice(start, end + 1));
}

const TARGET_RE = /^[A-Za-z0-9_.]{3,100}$/;
const TICKET_TITLE_MAX = 160;
const TICKET_TEXT_MAX = 1200;
const TICKET_FILES_MAX = 10;
/** A repo-relative path: no scheme, no `..`, no leading slash or drive. */
const REPO_PATH_RE = /^(?![a-zA-Z]:)(?!\/)(?!.*\.\.)[A-Za-z0-9_@.\-/[\]]{3,200}$/;

/** A ticket from the reply, trimmed and clamped; null when its title or proposed change is missing. */
export function ticketOf(raw: unknown): TicketProposal | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' ? clampText(v.trim(), max) : '');
  const title = str(t.title, TICKET_TITLE_MAX);
  const proposedChange = str(t.proposedChange, TICKET_TEXT_MAX);
  if (!title || !proposedChange) return null;
  const files = Array.isArray(t.files)
    ? [...new Set(t.files.filter((f): f is string => typeof f === 'string').map((f) => f.trim().replace(/\\/g, '/')).filter((f) => REPO_PATH_RE.test(f)))].slice(0, TICKET_FILES_MAX)
    : [];
  return { title, proposedChange, files, testDescription: str(t.testDescription, TICKET_TEXT_MAX) };
}
const WEIGHT_TARGET_RE = /^scorecard\.factor\.([a-z_]+)\.weight$/;

/**
 * Why an entry's lesson/proposal is not backed by the scorecards it cites, or null when it is (or
 * when none of its refIds has known factor points — verdicts, ideas and exits are not checked).
 */
export function groundingProblem(
  refIds: readonly string[],
  blamed: readonly string[],
  scored: ReadonlyMap<string, Readonly<Record<string, number>>>,
  proposalTarget?: string,
): string | null {
  const cards = refIds.map((id) => scored.get(id)).filter((f): f is Readonly<Record<string, number>> => f !== undefined);
  if (cards.length === 0) return null;
  const nonZero = new Set(cards.flatMap((f) => Object.entries(f).filter(([, p]) => p !== 0).map(([n]) => n)));
  if (blamed.length === 0) return 'no blamedFactors on a scorecard miss';
  const bad = blamed.filter((f) => !nonZero.has(f));
  if (bad.length > 0) return `blamed ${bad.join(', ')} not scored non-zero (scored: ${[...nonZero].join(', ') || 'none'})`;
  const w = proposalTarget ? WEIGHT_TARGET_RE.exec(proposalTarget) : null;
  if (w && !blamed.includes(w[1])) return `weight for ${w[1]}, which is not a blamed factor`;
  return null;
}

/**
 * Strict on the envelope, lenient per entry: a reply that is not `{misses: [...]}` throws;
 * an entry with no surviving refId, no cause or an unknown category is dropped; a bad
 * optional field (key, text, scope, target) is dropped from its entry alone. A lesson key
 * that is new needs `lessonText`; a key already active may come without it.
 *
 * GROUNDING: when an entry's refIds include scorecards with known factor points (`scored`), its
 * lesson and proposal survive only if `blamedFactors` names at least one factor and every one of
 * them scored non-zero on those scorecards; a weight proposal must be for a blamed factor. A
 * proposal for a target off the allow-list is dropped here too. The cause is always kept, with
 * `dropped` saying what was removed and why.
 */
export function validateDiagnosis(
  raw: unknown,
  sentRefIds: readonly string[],
  activeKeys: ReadonlySet<string>,
  scored: ReadonlyMap<string, Readonly<Record<string, number>>> = new Map(),
): DiagnosedMiss[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('diagnosis reply is not an object');
  const misses = (raw as { misses?: unknown }).misses;
  if (!Array.isArray(misses)) throw new Error('diagnosis reply has no misses array');
  const known = new Set(sentRefIds);
  const out: DiagnosedMiss[] = [];
  for (const m of misses) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) continue;
    const e = m as Record<string, unknown>;
    const refIds = Array.isArray(e.refIds) ? [...new Set(e.refIds.filter((r): r is string => typeof r === 'string' && known.has(r)))] : [];
    const cause = typeof e.cause === 'string' ? e.cause.trim() : '';
    const category = e.category;
    if (refIds.length === 0 || cause === '' || !(MISS_CATEGORIES as readonly unknown[]).includes(category)) continue;
    const d: DiagnosedMiss = { refIds, cause: clampText(cause, CAUSE_MAX), category: category as MissCategory };
    // causeType (d8): an unknown value is dropped with the reason; the group stays, with no ticket.
    if (e.causeType !== undefined && e.causeType !== null) {
      if ((FIX_CAUSES as readonly unknown[]).includes(e.causeType)) d.causeType = e.causeType as FixCause;
      else d.dropped = `causeType ${clampText(String(e.causeType), 40)}: unknown`;
    }
    if (e.ticket !== undefined && e.ticket !== null) {
      const t = d.causeType === 'CODE_BUG' || d.causeType === 'DATA' ? ticketOf(e.ticket) : null;
      if (t) d.ticket = t;
      else d.dropped = [d.dropped, d.causeType === 'CODE_BUG' || d.causeType === 'DATA' ? 'ticket: malformed' : `ticket: causeType ${d.causeType ?? 'missing'} takes none`].filter(Boolean).join('; ');
    }
    const noise = category === 'NOISE' || d.causeType === 'NOISE';
    const text = typeof e.lessonText === 'string' && e.lessonText.trim() !== '' ? clampText(e.lessonText) : undefined;
    if (isLessonKey(e.lessonKey) && !noise && (text || activeKeys.has(e.lessonKey))) {
      d.lessonKey = e.lessonKey;
      if (text) d.lessonText = text;
      if (isLessonScope(e.scope)) d.scope = e.scope;
    }
    if (Array.isArray(e.contradicts)) {
      const c = [...new Set(e.contradicts.filter((k): k is string => typeof k === 'string' && activeKeys.has(k) && k !== d.lessonKey))];
      if (c.length > 0) d.contradicts = c;
    }
    if (typeof e.proposalTarget === 'string' && TARGET_RE.test(e.proposalTarget) && (typeof e.proposedValue === 'boolean' || (typeof e.proposedValue === 'number' && Number.isFinite(e.proposedValue)))) {
      if (isAllowedTarget(e.proposalTarget)) {
        d.proposalTarget = e.proposalTarget;
        d.proposedValue = e.proposedValue;
      } else {
        d.dropped = [d.dropped, `proposal ${e.proposalTarget}: not a tunable`].filter(Boolean).join('; ');
      }
    }
    const blamed = Array.isArray(e.blamedFactors) ? [...new Set(e.blamedFactors.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map((f) => f.trim()))] : [];
    if (blamed.length > 0) d.blamedFactors = blamed;
    const ungrounded = groundingProblem(refIds, blamed, scored, d.proposalTarget);
    if (ungrounded && (d.lessonKey || d.proposalTarget)) {
      const what = [d.lessonKey && `lesson ${d.lessonKey}`, d.proposalTarget && `proposal ${d.proposalTarget}`].filter(Boolean).join(' + ');
      d.dropped = [d.dropped, `${what}: ${ungrounded}`].filter(Boolean).join('; ');
      delete d.lessonKey;
      delete d.lessonText;
      delete d.scope;
      delete d.proposalTarget;
      delete d.proposedValue;
    }
    out.push(d);
  }
  return out;
}
