import { BadRequestException, Body, Controller, ForbiddenException, Get, Inject, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { DESK_MANAGER_CONFIG, type DeskManagerConfig } from '../desk-manager.config';
import { DeskGuardService } from '../services/desk-guard.service';
import { ManagerRunnerService } from '../services/manager-runner.service';

interface Caller {
  userId: string;
  role?: string;
}

const MIN = 60_000;
const istDay = (d: Date) => new Date(d.getTime() + 330 * MIN).toISOString().slice(0, 10);
const istDayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 330 * MIN);

/** The owner's Desk page API (desk-manager spec §5.9). Owner account only. */
@Controller('api/desk-manager')
export class DeskManagerController {
  constructor(
    @Inject(DESK_MANAGER_CONFIG) private readonly cfg: DeskManagerConfig,
    private readonly guard: DeskGuardService,
    private readonly runner: ManagerRunnerService,
    private readonly prisma: PrismaService,
  ) {}

  private owner(user: Caller): string {
    const owner = this.cfg.ownerUserId;
    if (!user?.userId || !owner || user.userId !== owner) throw new ForbiddenException('The desk is the owner account only');
    return owner;
  }

  @Get('state')
  async state(@CurrentUser() user: Caller) {
    const owner = this.owner(user);
    const now = new Date();
    const [guard, run] = await Promise.all([
      this.guard.state(owner, now).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
      this.prisma.deskManagerRun.findFirst({
        where: { userId: owner },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true, finishedAt: true, summary: true, error: true, wakeReasons: true, packetMs: true, aiMs: true, mode: true },
      }),
    ]);
    const notCheckable = await this.prisma.$queryRaw<Array<{ code: string; n: bigint }>>`
      SELECT COALESCE(c->>'reasonCode', 'OTHER') AS code, COUNT(*) AS n
      FROM message_readings, jsonb_array_elements(claims) c
      WHERE session_date = ${istDay(now)} AND c->>'verdict' = 'NOT_CHECKABLE'
      GROUP BY 1 ORDER BY 2 DESC`.catch(() => []);
    return {
      mode: this.cfg.mode,
      opensBlocked: this.runner.opensBlocked(),
      lastCompletedAt: this.runner.lastCompletedAt(),
      lastRun: run,
      guard,
      dataHoles: notCheckable.map((r) => ({ code: r.code, count: Number(r.n) })),
    };
  }

  @Get('decisions')
  async decisions(@CurrentUser() user: Caller, @Query('date') date?: string) {
    const owner = this.owner(user);
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : istDay(new Date());
    const from = istDayStart(day);
    const to = new Date(from.getTime() + 24 * 60 * MIN);
    return this.prisma.deskManagerDecision.findMany({
      where: { userId: owner, createdAt: { gte: from, lt: to } },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: { id: true, runId: true, action: true, underlying: true, trackerId: true, payload: true, validation: true, status: true, result: true, grade: true, createdAt: true },
    });
  }

  @Post('guard/reset')
  async reset(@CurrentUser() user: Caller) {
    const owner = this.owner(user);
    await this.guard.reset(owner, new Date());
    return this.guard.state(owner, new Date());
  }

  @Post('pause')
  async pause(@CurrentUser() user: Caller, @Body() body: { scope?: string; minutes?: number }) {
    const owner = this.owner(user);
    const minutes = Number(body?.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 390) throw new BadRequestException('minutes must be a whole number from 1 to 390');
    const scope = String(body?.scope ?? 'all').trim().toUpperCase();
    await this.guard.pause(owner, scope === 'ALL' || scope === '' ? 'all' : scope, minutes, new Date());
    return this.guard.state(owner, new Date());
  }

  @Post('resume')
  async resume(@CurrentUser() user: Caller) {
    const owner = this.owner(user);
    await this.guard.resume(owner, new Date());
    return this.guard.state(owner, new Date());
  }
}
