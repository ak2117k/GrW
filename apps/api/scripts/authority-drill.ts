/**
 * AUTHORITY DRILL (supreme fixes W5, 2026-11-28). Proves the TRADE_AGENT_AUTHORITY=live exit path on one real
 * tracker WITHOUT SELLING: raises a drill alarm (`payload.drill = true`) through TRADE_ALARMS and prints the path the
 * running API takes — alarm → the trade agent's forced look → its verdict → the router / escalation runner (answer,
 * owner "DRILL" line, observe-only supreme confirm) → closed.
 *
 *   docker exec -w /app/apps/api grw-api npm run authority:drill -- --tracker <trackerId> [--rule FLOOR] [--wait-sec 660]
 *
 * Why it cannot sell (exit-authority/domain/drill.ts): the sentinel stores the drill look's EXIT_NOW as EXIT_ADVISORY
 * (the executor polls EXIT_NOW only) and arms no price trigger; the router refuses any drill-tagged verdict (SKIPPED
 * DRILL); the escalation runner never backstops or exits a drill alarm and sends it without Exit buttons; an Exit tap
 * on one is refused. This process itself only writes the one alarm row and then reads — no Nest app, no executor,
 * no broker. Exit code: 0 pass, 1 SAFETY FAILURE, 2 refused, 3 timed out.
 */
import { PrismaClient } from '@prisma/client';
import { TradeAlarmRepository } from '../src/modules/exit-authority/repositories/trade-alarm.repository';
import { EscalationRepository } from '../src/modules/exit-authority/repositories/escalation.repository';
import { TradeAlarmsService } from '../src/modules/exit-authority/services/trade-alarms.service';
import { isAgentVerdictStamp, SENTINEL_JUDGE_STAMP_PREFIX } from '../src/modules/exit-authority/domain/agent-verdict';
import { parseDrillArgs, runAuthorityDrill, type DrillDeps } from '../src/modules/exit-authority/services/authority-drill';

async function main(argv: string[]): Promise<number> {
  const opts = parseDrillArgs(argv);
  if ('error' in opts) {
    console.error(opts.error);
    return 2;
  }
  const prisma = new PrismaClient();
  try {
    const repo = new TradeAlarmRepository(prisma as never);
    const esc = new EscalationRepository(prisma as never);
    // No TRACKER_WAKE here (another process): the API's next sentinel pass reads the open alarm and forces the look.
    // The authority check is the env gate in runAuthorityDrill (this process never runs the boot check).
    const alarms = new TradeAlarmsService(repo, undefined, { isLive: () => true });
    const deps: DrillDeps = {
      env: process.env,
      tracker: (id) => prisma.tradeTracker.findUnique({ where: { id }, select: { id: true, userId: true, symbol: true, status: true } }) as never,
      raise: (a, now) => alarms.raise(a, now),
      alarm: (id) => esc.findById(id),
      verdictsSince: async (trackerId, since) => {
        const rows = await prisma.sentinelVerdict.findMany({
          where: { trackerId, createdAt: { gt: since }, promptVersion: { startsWith: SENTINEL_JUDGE_STAMP_PREFIX } },
          orderBy: { createdAt: 'asc' },
          take: 50,
          select: { id: true, verdict: true, createdAt: true, triggeredBy: true, reason: true, promptVersion: true },
        });
        return rows
          .filter((r) => isAgentVerdictStamp(r.promptVersion))
          .map((r) => ({ id: r.id, verdict: r.verdict, createdAt: r.createdAt, reason: r.reason, triggeredBy: Array.isArray(r.triggeredBy) ? r.triggeredBy.map(String) : [] }));
      },
      executions: async (verdictIds) =>
        prisma.aiExitExecution.findMany({ where: { verdictId: { in: verdictIds } }, select: { verdictId: true, status: true, reason: true } }),
      now: () => new Date(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      print: (line) => console.log(line),
    };
    return await runAuthorityDrill(deps, opts);
  } finally {
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`authority drill failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);
