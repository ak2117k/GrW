import { Injectable, Logger } from '@nestjs/common';
import { buildVocabulary, type Vocabulary } from '../domain/vocabulary';
import { SignalIntakeRepository } from '../repositories/signal-intake.repository';
import type { VocabularySource } from './signal-intake.service';

/**
 * Rebuilt from the instruments table at most this often. The table refreshes at 08:00 IST and adds the
 * day's new listings at 09:20 (instrument-master-refresh.cron): an hour picks those up before they trade.
 */
const TTL_MS = 3_600_000;

/**
 * The pre-filter / parser vocabulary: indices + commodities (static) and every active NSE cash
 * symbol from the `instruments` table. A failed read keeps the last good vocabulary (or the static
 * one), so the intake never stops on a DB hiccup.
 */
@Injectable()
export class SignalVocabularyService implements VocabularySource {
  private readonly logger = new Logger(SignalVocabularyService.name);
  private vocab: Vocabulary | null = null;
  private builtAt = 0;
  private loading: Promise<Vocabulary> | null = null;

  constructor(private readonly repo: SignalIntakeRepository) {}

  async get(): Promise<Vocabulary> {
    if (this.vocab && Date.now() - this.builtAt < TTL_MS) return this.vocab;
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(): Promise<Vocabulary> {
    try {
      const symbols = await this.repo.cashSymbols();
      this.vocab = buildVocabulary(symbols);
      this.builtAt = Date.now();
      this.logger.log(`[signal-intake] vocabulary: ${this.vocab.names.size} names (${symbols.length} NSE cash symbols)`);
    } catch (e) {
      this.logger.warn(`[signal-intake] vocabulary refresh failed, keeping the previous one: ${e instanceof Error ? e.message : String(e)}`);
      this.vocab ??= buildVocabulary([]);
      this.builtAt = Date.now() - TTL_MS + 10 * 60_000; // retry in 10 min
    }
    return this.vocab;
  }
}
