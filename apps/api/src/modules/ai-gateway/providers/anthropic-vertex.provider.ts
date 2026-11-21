import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import { vertexModelId, vertexModelMapFrom } from '../../trade-sentinel/services/llm-transport';
import type { TransportRequest } from '../transport.types';
import { AnthropicApiProvider, type AnthropicMessagesClient } from './anthropic-api.provider';
import type { ProviderName, ProviderResult } from './provider.types';

/** Vertex project + region, from `VERTEX_AI_PROJECT_ID` / `VERTEX_AI_LOCATION` (default `global`). */
export interface VertexSettings {
  projectId: string | undefined;
  region: string;
}

export function vertexSettingsFrom(env: NodeJS.ProcessEnv): VertexSettings {
  return {
    projectId: env.VERTEX_AI_PROJECT_ID?.trim() || undefined,
    region: env.VERTEX_AI_LOCATION?.trim() || 'global',
  };
}

/**
 * The Vertex SDK client, built LAZILY on the first request. Credentials come from
 * Google's default chain — on the server, the service-account key file named by
 * `GOOGLE_APPLICATION_CREDENTIALS` (mounted read-only, never in git).
 *
 * WHY LAZY: `new AnthropicVertex()` starts resolving Google credentials in its
 * constructor, and with none available that promise rejects UNHANDLED — which
 * kills the Node process. The gateway module builds every adapter at boot, so an
 * eager client would crash a deploy that never selected Vertex. Built on first
 * use, a missing key instead fails that request, which every caller already
 * classifies and degrades from (same as a missing ANTHROPIC_API_KEY).
 */
export function createVertexClient(
  settings: VertexSettings,
  build: (s: VertexSettings) => AnthropicMessagesClient = (s) =>
    new AnthropicVertex({ projectId: s.projectId, region: s.region }) as unknown as AnthropicMessagesClient,
): AnthropicMessagesClient {
  let client: AnthropicMessagesClient | null = null;
  return {
    messages: {
      create: (params) => {
        client ??= build(settings);
        return client.messages.create(params);
      },
    },
  };
}

/**
 * Serves a request from Claude on Vertex AI (metered, `billed: true`).
 *
 * The request and reply shapes are the Messages API's, so everything — image
 * mapping, the CLI-hint strip, token usage incl. cache reads/writes — is the API
 * provider's. The only difference is the model id ({@link vertexModelId}); the
 * ledger records the id actually served (`modelFor`).
 */
export class AnthropicVertexProvider extends AnthropicApiProvider {
  override readonly name: ProviderName = 'anthropic-vertex';

  constructor(
    client: AnthropicMessagesClient,
    /** `VERTEX_MODEL_MAP` overrides (see {@link vertexModelId}). */
    private readonly modelMap: Readonly<Record<string, string>> = vertexModelMapFrom(process.env.VERTEX_MODEL_MAP),
  ) {
    super(client);
  }

  modelFor(model: string): string {
    return vertexModelId(model, this.modelMap);
  }

  override send(request: TransportRequest): Promise<ProviderResult> {
    return super.send({ ...request, model: this.modelFor(request.model) });
  }
}
