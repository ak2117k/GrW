import { AsyncLocalStorage } from 'node:async_hooks';
import type { AiCallContext } from '../ai-gateway.service';

/**
 * Who an LLM call is FOR, carried beside the call rather than inside it.
 *
 * `MessagesTransport.messages.create(params)` takes only the request, and
 * widening that seam would touch every caller and every test double. The
 * callers that know the tenant and the position (the sentinel cycle, the
 * overnight review, the thesis inference) wrap their judge call in
 * {@link withAiCallContext}; the recording transport reads it back with
 * {@link currentAiCallContext} when it writes the `ai_calls` row.
 *
 * Absent context is normal (news ideas run for no position) and records NULLs.
 */
const storage = new AsyncLocalStorage<AiCallContext>();

export function withAiCallContext<T>(ctx: AiCallContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentAiCallContext(): AiCallContext {
  return storage.getStore() ?? {};
}
