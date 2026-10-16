/**
 * Position news context v3 shared shapes (docs/superpowers/specs/2026-10-16-position-news-context-design.md).
 * PURE — imports only types from ./types (news-events.structure.spec.ts asserts it): data tables,
 * DI token strings and interfaces every stream codes against without reaching another stream's code.
 */
import type { ArticleTags, FreshItem, IndexedArticle, MarketTag, NewsAsOf, NewsPosition, PositionKind } from './types';

/* ── drivers (§5.4) ── */
export const DRIVER_KEYS = [
  'CRUDE_SUPPLY', 'CRUDE_DEMAND', 'GOLD_MACRO', 'BASE_METALS', 'AGRI_MONSOON', 'INR_USD', 'GAS_WEATHER',
  'POWER_DEMAND', 'STEEL_CHINA', 'EDIBLE_OIL', 'US_TECH_SPEND', 'RBI_POLICY', 'FII_FLOWS', 'US_YIELDS',
] as const;
export type DriverKey = (typeof DRIVER_KEYS)[number];
export const isDriverKey = (s: string): s is DriverKey => (DRIVER_KEYS as readonly string[]).includes(s);
/** Which MCX benchmarks each driver moves; `primaryFor` ⊂ benchmarks wakes a COMMODITY position (K3). Phrases live in R4's catalogue. */
export const DRIVER_BENCHMARKS: Readonly<Record<DriverKey, { benchmarks: readonly string[]; primaryFor: readonly string[] }>> = {
  CRUDE_SUPPLY: { benchmarks: ['CRUDEOIL'], primaryFor: ['CRUDEOIL'] },
  CRUDE_DEMAND: { benchmarks: ['CRUDEOIL'], primaryFor: ['CRUDEOIL'] },
  GOLD_MACRO: { benchmarks: ['GOLD', 'SILVER'], primaryFor: ['GOLD'] },
  BASE_METALS: { benchmarks: ['COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'], primaryFor: ['COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'] },
  AGRI_MONSOON: { benchmarks: ['COTTON', 'CARDAMOM', 'MENTHAOIL', 'COTTONOIL'], primaryFor: ['COTTON', 'CARDAMOM'] },
  INR_USD: { benchmarks: ['CRUDEOIL', 'GOLD', 'SILVER', 'COPPER', 'NATURALGAS'], primaryFor: [] },
  GAS_WEATHER: { benchmarks: ['NATURALGAS'], primaryFor: ['NATURALGAS'] },
  POWER_DEMAND: { benchmarks: ['ELECDMBL', 'NATURALGAS'], primaryFor: ['ELECDMBL'] },
  STEEL_CHINA: { benchmarks: ['STEELREBAR'], primaryFor: ['STEELREBAR'] },
  EDIBLE_OIL: { benchmarks: ['COTTONOIL', 'SUNOIL'], primaryFor: ['COTTONOIL', 'SUNOIL'] },
  US_TECH_SPEND: { benchmarks: [], primaryFor: [] },
  RBI_POLICY: { benchmarks: [], primaryFor: [] },
  FII_FLOWS: { benchmarks: [], primaryFor: [] },
  US_YIELDS: { benchmarks: ['GOLD', 'SILVER'], primaryFor: [] },
};

/* ── DI tokens (strings; bound in I1) ── */
export const WORD_POLICY = 'NEWS_WORD_POLICY'; // R6 provides (NewsModule)
export const NEWS_LLM = 'NEWS_LLM'; // N1 provides (NewsLlmModule)
export const CANDIDATE_TAGGER = 'NEWS_CANDIDATE_TAGGER'; // R6
export const CANDIDATE_RELEVANCE = 'NEWS_CANDIDATE_RELEVANCE'; // P5
export const RETAG_RUNNER = 'NEWS_RETAG_RUNNER'; // R6 (RetagService)
export const INDEX_REBUILDER = 'NEWS_INDEX_REBUILDER'; // I1 → NewsIndexService
export const MATCHER_REBUILDER = 'NEWS_MATCHER_REBUILDER'; // P5
export const PROFILE_PREBUILDER = 'NEWS_PROFILE_PREBUILDER'; // P3
export const PROFILE_FLAGGER = 'NEWS_PROFILE_FLAGGER'; // P3
export const RULE_SET_ADMIN = 'NEWS_RULE_SET_ADMIN'; // R5/R6

/* ── profiles (§4.1) ── */
export type NameStrength = 'strong' | 'needs-context';
export interface ProfileName { text: string; strength: NameStrength }
export interface ProfileRelation { symbol: string; relation: 'parent' | 'subsidiary' | 'constituent'; names: ProfileName[] }
export interface ProfilePerson { fullName: string; role: string }
export interface ProfileDriver { key: DriverKey; note: string; primary: boolean }
export interface EntityProfile {
  symbol: string;
  kind: PositionKind;
  names: ProfileName[];
  parent: ProfileRelation[];
  subsidiaries: ProfileRelation[];
  related: ProfileRelation[]; // index constituents
  people: ProfilePerson[];
  products: ProfileName[];
  drivers: ProfileDriver[];
  sector: string | null;
  indices: string[];
  exclusions: string[];
}
export type ProfileRejectReason = 'not-unique' | 'prefix-shared' | 'needs-context-word' | 'blast-radius' | 'generic' | 'schema' | 'too-short';
export interface ProfileRejection { field: string; text: string; reason: ProfileRejectReason; detail?: string }
export type ProfileBuiltBy = 'baseline' | 'llm';
export interface StoredProfile {
  symbol: string; version: number; active: boolean; builtBy: ProfileBuiltBy; model: string | null;
  promptVersion: string | null; profile: EntityProfile; rejected: ProfileRejection[]; createdAt: Date;
}

/* ── matcher (§4.4) ── */
export type MatchLayer = 'own' | 'related' | 'driver';
export type MatchVia = 'name' | 'product' | 'person' | 'filing' | 'keyword' | 'relation' | 'driver';
export interface PositionMatch {
  articleId: string; layer: MatchLayer; via: MatchVia; why: string; strength: 'strong' | 'context';
  wakes: boolean; publishedAt: number;
}
export const positionKeyOf = (p: Pick<NewsPosition, 'kind' | 'key'>): string => `${p.kind}:${p.key}`;
export type PositionMatchesPeek =
  | { status: 'ok'; profileVersion: number; builtBy: ProfileBuiltBy; matches: readonly PositionMatch[] }
  | { status: 'warming' | 'unavailable'; reason: string };

/* ── ladder v3 (§4.5) ── */
export type NewsLayerV3 = 'instrument' | 'driver' | 'sector' | 'index' | 'market';
export interface LayeredHeadlineV3 {
  ref: string; title: string; source: string; sentiment: string | null; publishedAt: string;
  layer: NewsLayerV3; key: string; ageMin: number; why: string;
}
export type NewsPeekV3 =
  | {
      status: 'ok'; headlines: LayeredHeadlineV3[]; refs: Record<string, string>; newestAt: string | null;
      freshCount: number; fresh: FreshItem[]; asOf: NewsAsOf; dropped: Array<{ articleId: string; key: string }>;
    }
  | { status: 'warming' | 'unavailable'; reason: string };

/* ── word policy (§5.2) — implemented by R2, stubbed in testing-v3 ── */
export type ContextVerdict = 'company' | 'person' | 'none';
export interface WordPolicy {
  /** English word (top 30k), common Indian first/surname, or place ⇒ a single-word hit needs company context. */
  needsContext(word: string): boolean;
  /** Context around the hit covering tokens [start, end) of `tokens` (original case). Person beats company. */
  verdictAt(tokens: readonly string[], start: number, end: number): ContextVerdict;
}

/* ── rules as data (§6) ── */
export const RULE_KINDS = [
  'alias_add', 'alias_block', 'needs_context_word', 'generic_word', 'market_entity', 'driver_phrase', 'profile_flag', 'source_drop',
] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export type RuleStatus = 'proposed' | 'active' | 'rejected' | 'rolled_back';
export type RuleOrigin = 'seed' | 'curator' | 'owner';
/** params by kind: market_entity {market: MarketTag}; driver_phrase {driver: DriverKey}; profile_flag {reason}; source_drop {reason, nightsDown}; others {}. */
export interface TagRuleInput {
  kind: RuleKind; symbol: string | null; pattern: string; params: Record<string, unknown>; origin: RuleOrigin; evidence: Record<string, unknown>;
}
export interface TagRuleRow extends TagRuleInput { id: string; ruleSetVersion: number; status: RuleStatus; createdAt: Date }
export interface RuleSetRow { version: number; parentVersion: number | null; active: boolean; metrics: Record<string, unknown>; summary: string; appliedAt: Date | null }

/* ── feedback (§7) ── */
export const FEEDBACK_KINDS = ['wrong_company', 'irrelevant', 'misleading', 'missed', 'wrong_market'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_SIGNALS = ['judge', 'audit', 'stats', 'owner'] as const;
export type FeedbackSignal = (typeof FEEDBACK_SIGNALS)[number];
export interface FeedbackInput {
  articleId: string; tag: string; symbol: string | null; kind: FeedbackKind; signal: FeedbackSignal; reason: string;
  verdictId?: string | null; trackerId?: string | null; tagVersion: number; ruleSetVersion: number;
}
export type NewsIgnoredKind = 'irrelevant' | 'misleading' | 'wrong_company' | 'wrong_market';
export interface NewsIgnoredItem { ref: string; kind: NewsIgnoredKind; why: string }

/* ── LLM client (§11) — implemented by N1, stubbed in testing-v3 ── */
export type NewsLlmJob = 'news.profile' | 'news.audit' | 'news.curate' | 'news.label';
export type NewsLlmScope = 'night' | 'intraday';
export interface NewsLlmRequest { job: NewsLlmJob; scope: NewsLlmScope; system: string; user: string; schema: Record<string, unknown>; maxOutputTokens: number }
export type NewsLlmFailure = 'breaker-open' | 'cap-calls' | 'cap-tokens' | 'cap-intraday' | 'deadline' | 'session-open' | 'error' | 'unparseable';
export type NewsLlmResult =
  | { ok: true; json: unknown; tokensIn: number | null; tokensOut: number | null }
  | { ok: false; reason: NewsLlmFailure; detail: string };
export interface NightBudgetSnapshot { calls: number; tokensIn: number; tokensOut: number; costInr: number }
/** Never throws. */
export interface NewsLlm {
  call(req: NewsLlmRequest): Promise<NewsLlmResult>;
  breakerOpenUntil(): Date | null;
  usage(scope: NewsLlmScope): NightBudgetSnapshot;
}

/* ── night jobs (§9.1) ── */
export type NightJobName = 'news.audit' | 'news.curate' | 'news.prebuild';
export interface NightJobContext { job: NightJobName; nightOf: string; deadline: Date; llm: NewsLlm; log(line: string): void }
export interface NightJobOutcome { summary: Record<string, unknown> }

/* ── cross-stream ports used by night jobs ── */
export interface RetagRunner { retagWindow(now: Date, windowMs: number): Promise<number> }
export interface IndexRebuilder { rebuild(): Promise<void> }
export interface MatcherRebuilder { rebuildAll(): void }
export interface ProfilePrebuilder { prebuild(ctx: NightJobContext, limit: number): Promise<{ built: number; skipped: number; remaining: number }> }
export interface ProfileFlagger { flag(symbol: string, reason: string): Promise<void> }
/** Rule-set administration the curator and the owner endpoint use (R5 store behind R6's service). */
export interface RuleSetAdmin {
  activeVersion(): Promise<number>;
  activeRules(): Promise<TagRuleInput[]>;
  /** New immutable set = parent's active rules + `added`; activated in one transaction when `activate`. Returns its version. */
  createRuleSet(o: { parentVersion: number; added: readonly TagRuleInput[]; metrics: Record<string, unknown>; summary: string; activate: boolean }): Promise<number>;
  /** Proposed rows (status `proposed`) recorded against the current active version. */
  propose(rows: readonly TagRuleInput[]): Promise<number>;
  /** Activate the parent of the active set (parent 0 = seeds only: nothing active); null when nothing is active. The rules service then reloads + re-tags 48 h. */
  rollback(): Promise<{ from: number; to: number } | null>;
}

/* ── evaluation (§10) ── */
export interface LabelledHeadline {
  id: string; title: string; summary: string; source: string; category: string; publishedAt: string;
  labels: { companies: string[]; commodities: string[]; indices: string[]; markets: MarketTag[]; drivers: string[] };
  relevance: Array<{ symbol: string; label: 'relevant' | 'irrelevant' | 'misleading' }>;
  meta: { passA: string; passB: string; adjudicated: boolean; ownerChecked: boolean };
}
export type EvalKind = 'company' | 'commodity' | 'index' | 'market' | 'driver';
export interface KindScore { tp: number; fp: number; fn: number; precision: number | null; recall: number | null }
export interface EvalReport {
  n: number; byKind: Record<EvalKind, KindScore>; bySource: Record<string, Record<EvalKind, KindScore>>;
  marketAccuracy: number | null; relevance: { n: number; tp: number; fp: number; precision: number | null };
}
export type TagFn = (h: Pick<LabelledHeadline, 'title' | 'summary' | 'source' | 'category'>) => ArticleTags;
export type RelevanceFn = (h: LabelledHeadline, symbol: string) => boolean;
export interface CandidateTagger { forRules(rules: readonly TagRuleInput[]): TagFn }
export interface CandidateRelevance { forRules(rules: readonly TagRuleInput[]): RelevanceFn }

/** Re-exported so ports can stay single-import. */
export type { IndexedArticle };
