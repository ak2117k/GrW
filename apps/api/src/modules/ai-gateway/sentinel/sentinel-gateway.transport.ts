import { OVERNIGHT_VERDICT_SCHEMA, VERDICT_SCHEMA } from '../../trade-sentinel/services/sentinel-agent.service';
import { THESIS_SCHEMA } from '../../trade-sentinel/services/thesis.service';
import type { AiJob } from '../ai-job';
import type { AiGateway } from '../ai-gateway.service';
import type { MessagesTransport, TransportMessage, TransportRequest } from '../transport.types';

/**
 * Which sentinel job a request is, by the IDENTITY of its output schema (spec
 * §4.7). The sentinel passes its schema constants by reference (the
 * `as unknown as Record<string, unknown>` cast keeps the reference), so no
 * sentinel file has to change to label its calls. A copied or foreign schema is
 * `sentinel.unknown` — still served by the sentinel route, just labelled
 * honestly in `ai_calls`.
 */
export function jobFor(params: TransportRequest): AiJob {
  const schema: unknown = params.output_config?.format?.schema;
  if (schema === (VERDICT_SCHEMA as unknown)) return 'sentinel.judge';
  if (schema === (OVERNIGHT_VERDICT_SCHEMA as unknown)) return 'sentinel.overnight';
  if (schema === (THESIS_SCHEMA as unknown)) return 'sentinel.thesis';
  return 'sentinel.unknown';
}

/**
 * The sentinel's `ANTHROPIC_CLIENT` when `AI_GATEWAY_SENTINEL=true`: the same
 * `messages.create` seam, served by the AI gateway. The params object is handed
 * on untouched and the gateway's message (the provider's own object) is
 * returned untouched, so the sentinel cannot tell the difference — which the
 * golden suite proves.
 */
export class SentinelGatewayTransport implements MessagesTransport {
  readonly messages: { create(params: TransportRequest): Promise<TransportMessage> };

  constructor(gateway: AiGateway) {
    this.messages = {
      create: (params: TransportRequest) => gateway.call(jobFor(params), params),
    };
  }
}
