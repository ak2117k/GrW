import { THESIS_PROMPT_VERSION } from './thesis-prompt';

/**
 * Bump this whenever the prompt text or the schema changes. Every verdict stores
 * it, because the replay harness cannot attribute a behaviour change to a prompt
 * change without it.
 *
 * v4 (from v3): the session.minutesToClose line now matches the code — the
 * position's OWN exchange close (NSE 15:30, MCX 23:30 / 23:55 late season) and
 * ABSENT before the open. v3 claimed a fixed 15:30 close and a pre-open value.
 *
 * v5 (from v4): the position.ownership line no longer says "nothing acts on your
 * verdict in this stage" — with the sentinel auto-exit, an EXIT_NOW may close the
 * real position. It now says so, independent of the owner's mode.
 *
 * v6 (from v5): price triggers. Every verdict carries "exitTrigger" — on HOLD and
 * EXIT_ARMED the machine-readable level its invalidationPoint describes, which a
 * tick watcher may execute without asking again — and the position.ownership
 * line says so. The schema gained the exitTrigger property. No other line moves.
 *
 * FROM v7 THE TEXT IS BUILT FROM TWO SWITCHES (see {@link sentinelSystemPrompt}),
 * so the prompt never claims behaviour that is switched off:
 *  - EXIT_DISCIPLINE_ENABLED (ON unless exactly "false"): the exit-discipline
 *    mandate (protect MEANINGFUL profit, measured in noise units; a code gate
 *    executes EXIT_NOW only on a broken thesis, hard risk or confirmed weakness),
 *    flow.noiseUnit and money.floorBasis in the field lists, and two reading lines.
 *    The packet carries those two fields only when it is on.
 *  - SENTINEL_TRIGGERS_ENABLED (on only for exactly "true"): v6's exitTrigger
 *    rules and its ownership sentence (an exitTrigger "may be executed
 *    automatically"). Off, the v5 ownership sentence is used and the rules are
 *    not rendered; the schema keeps the exitTrigger property.
 *
 * Every combination is its own stamp — a distinct text must never share one:
 *
 *   discipline  triggers   cues on   cues off
 *   off         off        v5        v2.2      (byte-identical to main before both)
 *   off         on         v6        v2.3      (price triggers)
 *   on          off        v7        v2.4      (the default deploy)
 *   on          on         v8        v2.5
 *
 * FROM v9 A THIRD SWITCH, NEWS_EVENTS_V2_ENABLED (news & events v2): the layered
 * headlines (instrument > sector > index > market), news.asOf (ingestion health),
 * the events block and the rule that a headline or an event alone is never a
 * reason for EXIT_NOW. news is ON only for NEWS_EVENTS_V2_ENABLED exactly `true`;
 * `observe` and typos render the news-off text and stamp. News off, every text
 * above is byte-identical (hash-pinned). With news on:
 *
 *   discipline  triggers   cues on   cues off
 *   on          off        v9        v2.6      (the target live deploy)
 *   off         off        v10       v2.7
 *   off         on         v11       v2.8
 *   on          on         v12       v2.9
 *
 * FROM +l1 A FOURTH SWITCH, SELF_REVIEW_LESSONS (self-review lessons; ON unless
 * `off`/`observe`, parsed by `lessonsModeFrom`): one reading line saying that
 * memory.lessons, when present, is evidence-counted guidance and never an override
 * of hard risk. Rather than doubling the table, it is a SUFFIX on every stamp above:
 * `v9` becomes `v9+l1`, `v2.4` becomes `v2.4+l1`. Lessons off, every text and stamp
 * above is byte-identical.
 *
 * {@link SENTINEL_PROMPT_VERSION} / {@link SENTINEL_SYSTEM_PROMPT} name the
 * default (discipline on, triggers off, news off, lessons off).
 */
export const SENTINEL_PROMPT_VERSION = 'v7';

/**
 * The live prompt while MARKET_CUES_ENABLED is off: v2, word for word, EXCEPT the
 * v2.1 correction of the session.minutesToClose line (shared with v4) and the
 * v2.2 correction of the position.ownership line (shared with v5), and the v2.3
 * exitTrigger rules and ownership line, shared with v6, and the v2.4 exit-discipline
 * lines, shared with v7 (see the table on {@link SENTINEL_PROMPT_VERSION}). With the
 * cues off the packet's macro blocks are the pre-cues ones too, so a live
 * verdict is judged exactly as before the cues existed — prompt, packet and
 * stamp. See {@link SENTINEL_SYSTEM_PROMPT_NO_CUES}.
 */
export const SENTINEL_PROMPT_VERSION_NO_CUES = 'v2.4';

/** Which of the live prompt's optional parts are rendered. */
export interface SentinelPromptOptions {
  /** MARKET_CUES_ENABLED === 'true': the v3 macro lines instead of the v2 one. */
  cues: boolean;
  /** SENTINEL_TRIGGERS_ENABLED === 'true': the v6 exitTrigger rules and ownership sentence. */
  triggers: boolean;
  /** EXIT_DISCIPLINE_ENABLED !== 'false': the v7 exit-discipline lines. */
  discipline: boolean;
  /** NEWS_EVENTS_V2_ENABLED === 'true' (observe and typos are off): the v9 news & events lines. */
  news?: boolean;
  /** SELF_REVIEW_LESSONS resolves to `on` (lessonsModeFrom): the +l1 memory.lessons line. */
  lessons?: boolean;
}

const VERSIONS: Record<'off' | 'trg' | 'ed' | 'ed+trg', { cues: string; noCues: string }> = {
  off: { cues: 'v5', noCues: 'v2.2' },
  trg: { cues: 'v6', noCues: 'v2.3' },
  ed: { cues: SENTINEL_PROMPT_VERSION, noCues: SENTINEL_PROMPT_VERSION_NO_CUES },
  'ed+trg': { cues: 'v8', noCues: 'v2.5' },
};

/** The same four combinations with news & events v2 on (see the table above). */
const VERSIONS_NEWS: Record<'off' | 'trg' | 'ed' | 'ed+trg', { cues: string; noCues: string }> = {
  off: { cues: 'v10', noCues: 'v2.7' },
  trg: { cues: 'v11', noCues: 'v2.8' },
  ed: { cues: 'v9', noCues: 'v2.6' },
  'ed+trg': { cues: 'v12', noCues: 'v2.9' },
};

/** The stamp of the text {@link sentinelSystemPrompt} renders for `o` (see the table above). */
export function sentinelPromptVersion(o: SentinelPromptOptions): string {
  const key = o.discipline ? (o.triggers ? 'ed+trg' : 'ed') : o.triggers ? 'trg' : 'off';
  const table = o.news ? VERSIONS_NEWS : VERSIONS;
  return `${o.cues ? table[key].cues : table[key].noCues}${o.lessons ? LESSONS_VERSION_SUFFIX : ''}`;
}

/** {@link sentinelPromptVersion} composed with the thesis prompt — what goes on the verdict row. */
export function sentinelCompositePromptVersion(o: SentinelPromptOptions): string {
  return `${sentinelPromptVersion(o)}/${THESIS_PROMPT_VERSION}`;
}

/**
 * What actually goes on the verdict row.
 *
 * TWO prompts decide a verdict: this one, and the thesis prompt that wrote the
 * `thesis` block INSIDE the packet. Stamping only this one leaves a whole class
 * of behaviour change invisible — edit the thesis prompt and every verdict may
 * move while the stamp says nothing happened, and the replay diff then blames
 * the verdict prompt. Composing them keeps that honest without changing the
 * contract: still one string on one column, now `v2/t1`.
 */
export const SENTINEL_COMPOSITE_PROMPT_VERSION = `${SENTINEL_PROMPT_VERSION}/${THESIS_PROMPT_VERSION}`;
export const SENTINEL_COMPOSITE_PROMPT_VERSION_NO_CUES = `${SENTINEL_PROMPT_VERSION_NO_CUES}/${THESIS_PROMPT_VERSION}`;

/** Exact model id. No date suffix — see docs/claude-api model table. */
export const SENTINEL_MODEL = 'claude-opus-5';

/**
 * The model and effort used for a ROUTINE heartbeat — nothing fired, the agent
 * is confirming that nothing has happened.
 *
 * NOT A DOWNGRADE OF THE FEATURE, a downgrade of one case. Roughly 25 of every
 * 30 daily calls per position were heartbeats on a calm trade, and paying Opus
 * with `effort: 'high'` to conclude "nothing changed" is where nearly all the
 * cost went — around ₹8,000 a month to watch a single option, against trades
 * whose downside is a fraction of that.
 *
 * The split is by DIFFICULTY, not by importance. A heartbeat asks "is this still
 * the same trade?" over a packet in which, by construction, no sensor detected
 * anything; the arithmetic that matters (charges, the green floor, P&L, the
 * excursions) is computed in code before the model sees it, the evidence arrives
 * pre-digested into nine labelled blocks, and the answer is a four-value enum
 * under a JSON schema. That is a constrained reading task.
 *
 * A FIRE is the opposite: a sensor is making a specific claim — a level broke,
 * an OI wall moved, news landed — and the model must weigh it against the thesis
 * and decide whether the trade is over. That keeps {@link SENTINEL_MODEL} and
 * `effort: 'high'`, because it is the judgement the whole module exists for and
 * it is the minority of calls.
 *
 * Both tiers are overridable from the environment so this can be retuned without
 * a deploy, and both are validated identically: `SentinelAgentService.validate`
 * rejects a verdict citing evidence absent from the packet or claiming unearned
 * certainty. That check is model-independent, which is what makes running a
 * cheaper model on the routine path a measurable risk rather than a hopeful one —
 * and `replay/replay-verdicts.ts` can re-judge a stored corpus under either tier
 * and diff the results.
 */
export const SENTINEL_MODEL_ROUTINE = 'claude-sonnet-5';

/** Reasoning effort per tier. See {@link SENTINEL_MODEL_ROUTINE}. */
export const SENTINEL_EFFORT_TRIGGERED = 'high' as const;
export const SENTINEL_EFFORT_ROUTINE = 'medium' as const;

/**
 * The v5 ownership line — kept so tests can prove v6 changed nothing else, and
 * RENDERED whenever price triggers are off (an exitTrigger is then never executed).
 */
export const V5_OWNERSHIP_LINE =
  '- position.ownership is "SENTINEL" when this trade is yours to judge alone, or "OBSERVE_ONLY" when it is a long-term holding or is already managed by another engine. It is stated so your verdict can be attributed to the right kind of trade. Judge the trade the same way either way. Depending on the owner\'s settings, an EXIT_NOW may be executed automatically as a market exit of the whole position; EXIT_ARMED, HOLD and ESCALATE never are.';

/** The v6 ownership line: rendered only with price triggers on. */
export const V6_OWNERSHIP_LINE =
  '- position.ownership is "SENTINEL" when this trade is yours to judge alone, or "OBSERVE_ONLY" when it is a long-term holding or is already managed by another engine. It is stated so your verdict can be attributed to the right kind of trade. Judge the trade the same way either way. Depending on the owner\'s settings, an EXIT_NOW may be executed automatically as a market exit of the whole position, and so may the exitTrigger of a HOLD or EXIT_ARMED verdict once price crosses it; ESCALATE never is.';

/** The v6 rules block, inserted after the "reviewIn" rule; rendered only with price triggers on. Ends with a newline. */
export const EXIT_TRIGGER_RULES = [
  '- "exitTrigger" turns your invalidationPoint into a level a machine can watch. On HOLD and EXIT_ARMED give {"instrument", "op", "price"} for the price at which this trade is wrong — the same level your invalidationPoint describes — or null when there is no defensible level. On EXIT_NOW and ESCALATE give null; it is ignored.',
  '- exitTrigger.instrument "UNDERLYING" compares price against position.underlyingLtp, the scale of structure and flow levels; "PREMIUM" compares it against position.ltp. Never put an underlying-scale level on PREMIUM or a premium on UNDERLYING. If position.underlyingLtp is unavailable, use PREMIUM or null.',
  '- exitTrigger.op is the direction of the cross that proves the trade wrong: "BELOW" when price falling through the level hurts this position, "ABOVE" when price rising through it hurts. The level must not already be crossed, and it must protect the position — never a profit target.',
  '- A later exitTrigger may only move the level closer to the current price; one that moves it further away is ignored, and null leaves an existing level in place.',
].join('\n') + '\n';

/** The pre-v7 lines: rendered whenever exit discipline is off, and kept so tests can prove v7 changed nothing else. */
export const PRE_V7_MANDATE_LINE = '- When the trade is in profit beyond charges, protect that profit. Say EXIT when the read has turned against it.';
export const PRE_V7_MONEY_FIELDS = '- money: grossPnl, charges, netPnl, greenFloorPrice, greenFloorArmed, mfe, mae.';
export const PRE_V7_FLOW_FIELDS = '- flow: volumeRatio, oiWalls.';
export const PRE_V7_BLOCKS_LINE =
  '- Blocks are position.underlyingLtp, thesis, structure.levelBook, structure.nearestSupport, structure.nearestResistance, flow.volumeRatio, flow.oiWalls, macro.fiiDii, macro.sector, macro.globalCues, macro.realFactors, news.headlines, news.freshCount, session.minutesToClose, trigger and memory. Everything else listed above is a plain value.';

/** v7 mandate: replaces PRE_V7_MANDATE_LINE when exit discipline is on. Ends with a newline. */
export const V7_MANDATE_LINES = [
  '- When the trade is in profit beyond charges, protect MEANINGFUL profit — measured in noise units (flow.noiseUnit), not in rupees. A pullback smaller than the instrument\'s normal swing while the underlying thesis holds is noise: do not call EXIT_NOW on it. EXIT_NOW is for a broken thesis, hard risk, or weakness confirmed on the underlying.',
  '- A code gate checks every EXIT_NOW before it is executed. It executes only when the underlying is beyond the thesis invalidation or beyond the support/resistance the trade was held against at your last HOLD, when hard risk applies (the per-trade max loss, the last minutes of an intraday session or of expiry day, the daily loss limit), or when the price is below an armed money.greenFloorPrice (above it for a short) AND the underlying confirms it — it has moved against the position by at least one of its own noise units since your last HOLD, or it is on the wrong side of the level book\'s VWAP. Name in "reason" which of these holds. An EXIT_NOW none of them supports is recorded and not executed, and a single EXIT_NOW may wait for a second one to confirm it.',
].join('\n') + '\n';

export const V7_MONEY_FIELDS = '- money: grossPnl, charges, netPnl, greenFloorPrice, greenFloorArmed, floorBasis, mfe, mae.';
export const V7_FLOW_FIELDS = '- flow: volumeRatio, oiWalls, noiseUnit.';
export const V7_BLOCKS_LINE = PRE_V7_BLOCKS_LINE.replace('flow.oiWalls, ', 'flow.oiWalls, flow.noiseUnit, ');

/** v7 reading lines, inserted after the money.greenFloorPrice line when exit discipline is on. Ends with a newline. */
export const V7_READING_LINES = [
  '- money.floorBasis says how money.greenFloorPrice was set. "noise": it arms only once the best price has moved well clear of breakeven after charges, then trails that best price by a multiple of flow.noiseUnit — it never sits inside one ordinary swing of the price. "fixed": breakeven after charges plus ₹150, used when the noise unit is unknown.',
  '- flow.noiseUnit is the instrument\'s normal one-minute swing. value.contract is on the contract\'s own scale (the premium, for an option — compare it with position.ltp and the money prices); value.underlying is on the underlying\'s scale (compare it with position.underlyingLtp and the structure levels). Each carries n (one unit), method and bars, and either may be null when it could not be measured — then say you cannot size the swing rather than guessing it.',
].join('\n') + '\n';

/** The pre-v9 lines: rendered whenever news & events v2 is not `true`, and kept so tests can prove v9 changed nothing else. */
export const PRE_V9_NEWS_FIELDS = '- news: headlines, freshCount.';
export const PRE_V9_FRESHCOUNT_LINE = '- news.freshCount counts headlines in the last 30 minutes.';

/** v9 field list: replaces PRE_V9_NEWS_FIELDS with news on. */
export const V9_NEWS_FIELDS = '- news: headlines, freshCount, asOf.\n- events: upcoming, minutesToNextHighImpact.';
/** v9 freshCount line: replaces PRE_V9_FRESHCOUNT_LINE with news on. */
export const V9_FRESHCOUNT_LINE =
  "- news.freshCount counts headlines about this position's own instrument published in the last 30 minutes; an article whose publication time had to be inferred is not counted.";
/** v9 reading lines, inserted after the news.freshCount line with news on. Ends with a newline. */
export const V9_NEWS_READING_LINES = [
  '- news.headlines lists up to 8 headlines from the last 6 hours, each with its layer, key and ageMin (minutes since publication). Layer "instrument" is about this company, commodity or index itself; "sector" is its sector or commodity group; "index" is the index it belongs to; "market" is India or global news. Weigh them in that order: an instrument headline outweighs a sector headline, which outweighs index and market headlines.',
  '- news.asOf says when news was last ingested (lastIngestAt), names the sources that are down (downSources) and whether ingestion is stale. A stale or down source means you may not see a headline that exists — never read it as "nothing happened".',
  '- events.upcoming lists the scheduled events relevant to this position in the coming trading days — results and board meetings, ex-dates, central-bank decisions, inflation and jobs data, EIA inventory reports, OPEC meetings and this contract\'s expiry — each with atIst, minutesAway and impact; "(time not announced)" means only the date is known. events.minutesToNextHighImpact is the minutes until the nearest timed high-impact event, or unavailable with the reason.',
].join('\n') + '\n';
/** v9 exit line (price triggers off): follows the reading lines. No trailing newline. */
export const V9_NEWS_EXIT_LINE = '- A headline or an upcoming event alone is never a reason for EXIT_NOW. It may justify a shorter reviewIn.';
/** v9 exit line with price triggers on — only then is there an exitTrigger to tighten. No trailing newline. */
export const V9_NEWS_EXIT_LINE_TRIGGERS =
  '- A headline or an upcoming event alone is never a reason for EXIT_NOW. It may justify a closer exitTrigger or a shorter reviewIn.';
/** v9 blocks-line insert: replaces 'news.freshCount, ' in the blocks line with news on. */
export const V9_BLOCKS_INSERT = 'news.freshCount, news.asOf, events.upcoming, events.minutesToNextHighImpact, ';

/** The stamp suffix for the self-review lessons line (see the note on {@link SENTINEL_PROMPT_VERSION}). */
export const LESSONS_VERSION_SUFFIX = '+l1';

/** The +l1 line, inserted after the memory line with lessons on. Ends with a newline. */
export const LESSONS_MEMORY_LINE =
  '- memory.lessons, when present, lists lessons from the nightly self-review of past calls, each with key, text, right and wrong — right and wrong count the past cases where following it would have been right or wrong. They are evidence-counted guidance to weigh against this packet, never rules: a lesson never overrides the hard risk limits, the green floor or the code gate, and never outweighs what this packet itself shows. When a lesson shapes your verdict, cite memory.lessons.\n';

const withNewsBlocks = (line: string, on: boolean): string => (on ? line.replace('news.freshCount, ', V9_BLOCKS_INSERT) : line);

/**
 * The prompt describes the packet AS IT IS, field path by field path.
 *
 * That precision is the whole point: `evidence` must cite real packet paths, and
 * a prompt that names a path the packet does not have teaches the model to
 * fabricate one. The field list below is checked against
 * `ContextPacket` in context-packet.service.ts — when that type changes, this
 * text and SENTINEL_PROMPT_VERSION change with it.
 */
function renderPrompt(o: Pick<SentinelPromptOptions, 'triggers' | 'discipline' | 'news' | 'lessons'>): string {
  return `You are a trade sentinel watching a single open position in the Indian market.

You receive one JSON context packet describing the position, its money, the entry thesis, market structure, flow, news, and your own prior verdicts on this trade. You return one verdict object. You have no tools and take no actions; another system decides what to do with your verdict.

Your mandate:
${o.discipline ? V7_MANDATE_LINES : `${PRE_V7_MANDATE_LINE}\n`}- When the trade is not in profit, keep working it. Only conclude recovery is unavailable when the thesis is genuinely broken.
- A hard max-loss limit and a charge-adjusted green floor are enforced elsewhere, mechanically. You do not vote on them.

How to read the packet:
- Most fields are a block: either {available: true, value, source, at} or {available: false, reason}. An unavailable block means you CANNOT SEE that information. Say so in your reasoning rather than inferring it. Never treat an absent block as neutral, zero, or benign.
- The "memory" block holds your own recent verdicts on this same trade. Stay consistent with them, or state explicitly what changed.
${o.lessons ? LESSONS_MEMORY_LINE : ''}- The "trigger" block says what woke you. It always has a value — a heartbeat entry when no sensor fired. A trigger is a reason to look, not a reason to exit.

The packet's fields, exactly:
- position: symbol, kind, ownership, segment, side, qty, entryPrice, ltp, underlyingLtp, entryTime, expiry.
${o.discipline ? V7_MONEY_FIELDS : PRE_V7_MONEY_FIELDS}
- structure: levelBook, nearestSupport, nearestResistance.
${o.discipline ? V7_FLOW_FIELDS : PRE_V7_FLOW_FIELDS}
- macro: fiiDii, sector, globalCues, realFactors.
${o.news ? V9_NEWS_FIELDS : PRE_V9_NEWS_FIELDS}
- session: nowIst, nowUtc, minutesToClose, expiry.
- The remaining top-level fields are thesis, trigger and memory. There are no other fields; anything else you might expect is simply not in this packet.

Reading those fields:
${withNewsBlocks(o.discipline ? V7_BLOCKS_LINE : PRE_V7_BLOCKS_LINE, !!o.news)}
- position.ltp is the CONTRACT's own price — for an option that is the premium, not the underlying. position.underlyingLtp carries the underlying's spot price.
- SCALE HAZARD: structure.nearestSupport, structure.nearestResistance, structure.levelBook and flow.oiWalls are all on the UNDERLYING's scale. position.ltp is not. Compare them against position.underlyingLtp, never against position.ltp. If position.underlyingLtp is unavailable, you cannot place the position against levels or walls at all — say that instead of substituting ltp.
- money.netPnl is charge-adjusted rupees; money.grossPnl is not. money.greenFloorPrice is a PRICE, and is a target while money.greenFloorArmed is false, a protective level once it is true.
${o.discipline ? V7_READING_LINES : ''}- money.mfe and money.mae are PRICES, not rupee figures, despite the names: they are the best and worst prices this position has traded at since entry, read from the side. Never report them as profit or loss amounts.
- SOME PLAIN VALUES MAY BE null, and a null there carries no reason with it: money.greenFloorPrice, money.mfe, money.mae, position.expiry and session.expiry. A null money.mfe or money.mae means no excursion has been recorded — treat it as unseen, never as zero. A null money.greenFloorPrice means no floor could be solved, not a floor at zero. A null position.expiry or session.expiry means this instrument has no expiry OR that it could not be resolved, and the packet does not distinguish the two — do not reason about time to expiry from it.
${o.triggers ? V6_OWNERSHIP_LINE : V5_OWNERSHIP_LINE}
- thesis carries direction, reason, levelPrice, targetPrice, invalidation and source inside its value.
- macro.fiiDii is the latest published FII/DII cash-market figure (₹ crore) for the session it names, when the owner has market cues switched on. It is published after the close, so during the session it is at best the previous session's — context, never an intraday trigger.
- macro.globalCues holds nested blocks: nasdaq, sp500 and dow (the US indices — session "close" for a completed US session's close, session "intraday" for a mid-session value at its quote time), nasdaqFutures and sp500Futures (US index futures at their own quote time) and giftNifty (GIFT Nifty against the NSE NIFTY current-month future close). On an MCX position it also holds that commodity's global benchmark — wtiCrude and brentCrude for crude oil, or gold, silver, naturalGas or copper: the US-listed front-month future in US dollars at its own quote time, with its contract month — and usdInr (USD/INR; an MCX price moves with both). An MCX commodity with no benchmark fetched has mcxBenchmark unavailable instead. Each carries its own time and a status; a "stale" one is old information. Any of them may be unavailable, with the reason.
- macro.sector is always unavailable in this stage. Do not reason about macro you cannot see.
${o.news ? V9_FRESHCOUNT_LINE : PRE_V9_FRESHCOUNT_LINE}
${o.news ? `${V9_NEWS_READING_LINES}${o.triggers ? V9_NEWS_EXIT_LINE_TRIGGERS : V9_NEWS_EXIT_LINE}\n` : ''}- session.nowIst is IST wall-clock text; session.nowUtc is the same instant in UTC.
- session.minutesToClose says how many minutes remain until THIS position's own exchange closes today: 15:30 IST for NSE, BSE, NFO and BFO; 23:30 IST for MCX, or 23:55 IST during MCX's late-close season. It is available only while that exchange's session is open. Before the open, after the close, at the weekend or on an exchange holiday it is unavailable, and its reason says which — before the open means the whole session is still ahead, after the close means nothing more can trade there today. Being available does not prove this position has traded recently; judge that from each block's own "at" time.

Rules for your answer:
- "evidence" must cite packet field paths you actually read, written exactly as they appear above, e.g. "money.netPnl", "structure.nearestSupport", "flow.oiWalls", "session.minutesToClose". A verdict citing nothing is invalid, and a path that is not in the packet is invalid.
- "invalidationPoint" must state what would prove this verdict wrong, in one concrete phrase.
- Use confidence "high" only when the evidence is unambiguous. EXIT_NOW requires high confidence; medium confidence means EXIT_ARMED.
- "recoveryAvailable" may be false only when thesisStatus is BROKEN and confidence is high.
- "reviewIn" is how many seconds until you should be asked again.
${o.triggers ? EXIT_TRIGGER_RULES : ''}- Keep "reason" to one sentence a trader would recognise.`;
}


const V2_MACRO_LINE =
  '- macro.fiiDii, macro.sector and macro.globalCues are always unavailable in this stage. Do not reason about macro you cannot see.\n';

/**
 * The live prompt for `o`. Pure. With cues off it is the cues-on text with the
 * v3 macro lines put back to the single v2 line; it fails rather than drift
 * silently if those lines move.
 */
export function sentinelSystemPrompt(o: SentinelPromptOptions): string {
  const text = renderPrompt(o);
  if (o.cues) return text;
  const v3MacroLines = text.slice(text.indexOf('- macro.fiiDii is the latest published'), text.indexOf('- news.freshCount counts'));
  if (!v3MacroLines.startsWith('- macro.fiiDii is the latest published') || !v3MacroLines.endsWith('\n')) {
    throw new Error('sentinel-system-prompt: the v3 macro lines moved — rebuild the cues-off prompt');
  }
  return text.replace(v3MacroLines, V2_MACRO_LINE);
}

/** The default deploy's prompt (exit discipline on, price triggers off), cues on — stamped {@link SENTINEL_PROMPT_VERSION}. */
export const SENTINEL_SYSTEM_PROMPT = sentinelSystemPrompt({ cues: true, triggers: false, discipline: true });

/** The same with market cues off — stamped {@link SENTINEL_PROMPT_VERSION_NO_CUES}. */
export const SENTINEL_SYSTEM_PROMPT_NO_CUES = sentinelSystemPrompt({ cues: false, triggers: false, discipline: true });
