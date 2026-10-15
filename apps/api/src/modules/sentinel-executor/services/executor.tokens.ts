// apps/api/src/modules/sentinel-executor/services/executor.tokens.ts
/**
 * DI tokens of the exit executor, in their own file so ExitGateService can inject
 * the session clock without importing the executor (no runtime import cycle).
 */
export const AI_EXIT_SESSION_CLOCK = Symbol('AI_EXIT_SESSION_CLOCK');
export const AI_EXIT_SLEEP = Symbol('AI_EXIT_SLEEP');
