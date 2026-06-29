import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TradingStrategy } from '../../../common/interfaces/trading-strategy.interface';
import { SettingsService } from '../../settings/services/settings.service';
import { RsiReversalStrategy } from '../strategies/rsi-reversal.strategy';
import { EmaCrossoverStrategy } from '../strategies/ema-crossover.strategy';
import { VwapDeviationStrategy } from '../strategies/vwap-deviation.strategy';
import { AnandSniperV25CombinedStrategy } from '../strategies/anand-sniper-v25-combined.strategy';
import { ChartinkGatedStrategy } from '../strategies/chartink-gated.strategy';
import { LevelsContextStrategy } from '../strategies/levels-context.strategy';

@Injectable()
export class StrategyRegistryService implements OnModuleInit {
  private readonly logger = new Logger(StrategyRegistryService.name);
  private readonly strategies = new Map<string, TradingStrategy>();

  constructor(
    private readonly settingsService: SettingsService,
    private readonly rsiReversalStrategy: RsiReversalStrategy,
    private readonly emaCrossoverStrategy: EmaCrossoverStrategy,
    private readonly vwapDeviationStrategy: VwapDeviationStrategy,
    private readonly anandSniperV25CombinedStrategy: AnandSniperV25CombinedStrategy,
    private readonly chartinkGatedStrategy: ChartinkGatedStrategy,
  ) {}

  async onModuleInit(): Promise<void> {
    // Register built-in strategies
    this.register(this.rsiReversalStrategy);
    this.register(this.emaCrossoverStrategy);
    this.register(this.vwapDeviationStrategy);
    this.register(this.anandSniperV25CombinedStrategy);
    this.register(this.chartinkGatedStrategy);

    // Register the levels-context strategy — constructed directly (no NestJS
    // injection needed; it has no service dependencies).
    this.register(new LevelsContextStrategy());

    this.logger.log(
      `Strategy registry initialized with ${this.strategies.size} strategies`,
    );
  }

  /**
   * Register a trading strategy in the registry.
   */
  register(strategy: TradingStrategy): void {
    if (this.strategies.has(strategy.name)) {
      this.logger.warn(
        `Strategy "${strategy.name}" is already registered — overwriting`,
      );
    }
    this.strategies.set(strategy.name, strategy);
    this.logger.log(
      `Registered strategy: ${strategy.name} (segments: ${strategy.supportedSegments.join(', ')})`,
    );
  }

  /**
   * Remove a strategy from the registry.
   */
  unregister(name: string): boolean {
    const removed = this.strategies.delete(name);
    if (removed) {
      this.logger.log(`Unregistered strategy: ${name}`);
    }
    return removed;
  }

  /**
   * Get a strategy by name.
   */
  getStrategy(name: string): TradingStrategy | undefined {
    return this.strategies.get(name);
  }

  /**
   * Get all strategies that are in the user's activeStrategies setting.
   * Falls back to ALL registered strategies when activeStrategies is empty
   * or none of the listed names match a registered strategy.
   */
  async getActiveStrategies(): Promise<TradingStrategy[]> {
    const settings = await this.settingsService.getSettings();
    const activeNames: string[] = settings.activeStrategies ?? [];

    if (activeNames.length === 0) {
      this.logger.debug(
        'No activeStrategies configured — falling back to all registered strategies',
      );
      return Array.from(this.strategies.values());
    }

    const active: TradingStrategy[] = [];
    for (const name of activeNames) {
      const strategy = this.strategies.get(name);
      if (strategy) {
        active.push(strategy);
      } else {
        this.logger.warn(
          `Active strategy "${name}" is not registered in the registry`,
        );
      }
    }

    if (active.length === 0 && this.strategies.size > 0) {
      this.logger.warn(
        `None of the activeStrategies [${activeNames.join(', ')}] matched registered strategies — falling back to all registered`,
      );
      return Array.from(this.strategies.values());
    }

    return active;
  }

  /**
   * List all registered strategies with metadata.
   */
  getAllStrategies(): Array<{
    name: string;
    description: string;
    supportedSegments: string[];
    preferredTimeframes: string[];
    parameters: Record<string, any>;
  }> {
    return Array.from(this.strategies.values()).map((s) => ({
      name: s.name,
      description: s.description,
      supportedSegments: s.supportedSegments,
      preferredTimeframes: s.preferredTimeframes,
      parameters: s.getParameters(),
    }));
  }
}
