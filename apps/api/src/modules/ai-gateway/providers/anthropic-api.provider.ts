import type { TransportMessage, TransportRequest } from '../transport.types';
import type { ProviderAdapter, ProviderName, ProviderResult } from './provider.types';

/** The SDK reply: a transport message plus the token usage the API reports. */
export type AnthropicApiReply = TransportMessage & {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
};

/** The narrow slice of the Anthropic SDK client this provider calls. */
export interface AnthropicMessagesClient {
  messages: { create(params: TransportRequest): Promise<AnthropicApiReply> };
}

/** A token count the API reported, or `null` — never a default. */
function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Serves a request from the Anthropic API (metered, so `billed: true`).
 *
 * BEHAVIOUR-PRESERVING BY CONSTRUCTION. The request is handed to the SDK as the
 * one and only argument, exactly as the sentinel passed it before, and the
 * reply object is returned BY REFERENCE — not copied, not narrowed — so anything
 * downstream sees precisely the object it saw when it called the SDK directly.
 * Errors propagate untouched, so typed SDK errors keep their class.
 */
export class AnthropicApiProvider implements ProviderAdapter {
  readonly name: ProviderName = 'anthropic-api';

  constructor(private readonly client: AnthropicMessagesClient) {}

  async send(request: TransportRequest): Promise<ProviderResult> {
    const message = await this.client.messages.create(request);
    return {
      message,
      meta: {
        inputTokens: tokenCount(message.usage?.input_tokens),
        outputTokens: tokenCount(message.usage?.output_tokens),
        cacheCreationInputTokens: tokenCount(message.usage?.cache_creation_input_tokens),
        cacheReadInputTokens: tokenCount(message.usage?.cache_read_input_tokens),
        billed: true,
      },
    };
  }
}
