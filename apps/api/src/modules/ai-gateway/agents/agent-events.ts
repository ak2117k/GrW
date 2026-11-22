import { EventEmitter } from 'node:events';
import type { AgentGroup } from './agent-registry';

/** `fallback`: an agent was unreachable (or marked down) and the API served the call in-process. */
export interface AgentFallbackEvent {
  group: AgentGroup;
  job: string;
  reason: string;
}

/** `quota`: Vertex answered 429 / quota; the global limiter halved the non-trading share for 60 s. */
export interface AgentQuotaEvent {
  job: string;
}

/** `busy`: a call failed `AgentBusyError` (agent semaphore or the API's global limiter). */
export interface AgentBusyEvent {
  group: AgentGroup | 'in-process';
  job: string;
}

/**
 * Process-wide agent events, for the owner alerts (design §4.6). Plain Node emitter so the
 * provider (built outside Nest DI in `directRecordedTransport`) and the alert service share it.
 * Listeners must never throw; emit sites guard anyway.
 */
export const agentEvents: EventEmitter = new EventEmitter();
agentEvents.setMaxListeners(50);

/** Emit without ever letting a listener's error reach the AI call path. */
export function emitAgentEvent(
  event: 'fallback' | 'quota' | 'busy',
  payload: AgentFallbackEvent | AgentQuotaEvent | AgentBusyEvent,
): void {
  try {
    agentEvents.emit(event, payload);
  } catch {
    /* a broken listener must not fail an AI call */
  }
}
