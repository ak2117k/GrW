/**
 * Agent container entry point: `node apps/api/dist/agents/main.js` (design §4.3).
 *
 * Same image as the API, different command. Env:
 *   AGENT_GROUP                      trading | reading | background (required)
 *   AGENT_LISTEN_PORT (or AGENT_PORT) optional; default 5300
 *   VERTEX_AI_PROJECT_ID / VERTEX_AI_LOCATION / VERTEX_MODEL_MAP, GOOGLE_APPLICATION_CREDENTIALS
 *   AI_CONFIG_DIR                    where config/ai-agents.json lives
 *
 * Imports ONLY the Vertex provider, the model map and the registry reader — no NestJS, no Prisma,
 * no broker code — to keep the process ≤ 100 MB RSS.
 */
import { AGENT_PROTOCOL } from '../modules/ai-gateway/agents/agent-protocol';
import { AGENT_GROUPS, AGENT_PORT, loadAgentRegistry, type AgentGroup, type AgentRegistry } from '../modules/ai-gateway/agents/agent-registry';
import { AnthropicVertexProvider, createVertexClient, vertexSettingsFrom } from '../modules/ai-gateway/providers/anthropic-vertex.provider';
import { AgentServer } from './agent-server';

const SHUTDOWN_GRACE_MS = 10_000;

function fatal(msg: string): never {
  process.stderr.write(`[agent] FATAL ${msg}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const group = process.env.AGENT_GROUP?.trim().toLowerCase() as AgentGroup | undefined;
  if (!group || !AGENT_GROUPS.includes(group)) fatal(`AGENT_GROUP must be one of ${AGENT_GROUPS.join('|')}, got "${process.env.AGENT_GROUP ?? ''}"`);

  const portRaw = (process.env.AGENT_LISTEN_PORT ?? process.env.AGENT_PORT)?.trim();
  const port = portRaw ? Number(portRaw) : AGENT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fatal(`AGENT_LISTEN_PORT invalid: "${portRaw}"`);

  let registry: AgentRegistry;
  try {
    registry = loadAgentRegistry(process.env);
  } catch (err) {
    fatal(`agent registry unreadable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const provider = new AnthropicVertexProvider(createVertexClient(vertexSettingsFrom(process.env)));
  const agent = new AgentServer({ group, registry, provider });

  // A stray rejection (e.g. Google credential resolution) must be logged, not crash every in-flight call.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[agent ${group}] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}\n`);
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`[agent ${group}] ${signal}: stop accepting, draining in-flight (≤ ${SHUTDOWN_GRACE_MS} ms)\n`);
    agent
      .stop(SHUTDOWN_GRACE_MS)
      .then((drained) => {
        process.stdout.write(`[agent ${group}] stopped (${drained ? 'drained' : 'grace expired'}, late discarded ${agent.lateDiscarded})\n`);
        process.exit(0);
      })
      .catch(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const bound = await agent.listen(port);
  const jobs = registry.jobsOf(group);
  process.stdout.write(
    `[agent ${group}] listening on :${bound} protocol=${AGENT_PROTOCOL} jobs=${jobs.join(',') || '(none; unknown jobs only)'} rssMb=${Math.round(process.memoryUsage().rss / 1048576)}\n`,
  );
}

main().catch((err) => fatal(err instanceof Error ? err.stack ?? err.message : String(err)));
