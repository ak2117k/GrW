import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The CALLER's time budget for one agent-routed AI call, carried beside the call (like
 * `withAiCallContext`) because `MessagesTransport.messages.create(params)` takes only the request.
 *
 * - `startBy`  (epoch ms) — the latest the call may START on Vertex. Past it the caller has already
 *   given up on a slot (its `maxWaitMs`), so starting would spend money on an answer nobody reads.
 * - `abortAt`  (epoch ms) — the caller's own overall timeout. `AgentProvider` aborts the request then,
 *   and the agent cancels the Vertex call, so an abandoned call frees its agent slot and its global
 *   limiter slot together.
 *
 * `AgentProvider` uses min(caller budget, registry profile) for the limiter wait, the agent's start
 * deadline and the abort. Absent = the profile alone (callers that never set a budget).
 */
export interface AgentCallBudget {
  startBy?: number;
  abortAt?: number;
}

const storage = new AsyncLocalStorage<AgentCallBudget>();

const minDefined = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/** Runs `fn` under `budget`; a nested budget can only tighten the outer one. */
export function withAgentCallBudget<T>(budget: AgentCallBudget, fn: () => Promise<T>): Promise<T> {
  const outer = storage.getStore();
  const merged: AgentCallBudget = outer
    ? { startBy: minDefined(outer.startBy, budget.startBy), abortAt: minDefined(outer.abortAt, budget.abortAt) }
    : budget;
  return storage.run(merged, fn);
}

export function currentAgentCallBudget(): AgentCallBudget {
  return storage.getStore() ?? {};
}
