import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { UserStrategyDto } from '../dto/user-strategy.dto';

const STORAGE_DIR = path.resolve(process.cwd(), 'data');
const STORAGE_FILE = path.join(STORAGE_DIR, 'user-strategies.json');

@Injectable()
export class StrategyStorageService implements OnModuleInit {
  private readonly logger = new Logger(StrategyStorageService.name);
  private strategies = new Map<string, UserStrategyDto>();

  onModuleInit(): void {
    this.loadFromDisk();
  }

  // ── CRUD ───────────────────────────────────────────────────────────

  save(dto: UserStrategyDto): UserStrategyDto {
    const id = dto.id ?? crypto.randomUUID();
    const now = new Date();
    const strategy: UserStrategyDto = {
      ...dto,
      id,
      createdAt: dto.createdAt ?? now,
      updatedAt: now,
    };
    this.strategies.set(id, strategy);
    this.persistToDisk();
    this.logger.log(`Strategy saved: ${strategy.name} (${id})`);
    return strategy;
  }

  findAll(): UserStrategyDto[] {
    return Array.from(this.strategies.values());
  }

  findById(id: string): UserStrategyDto | undefined {
    return this.strategies.get(id);
  }

  delete(id: string): boolean {
    const existed = this.strategies.delete(id);
    if (existed) {
      this.persistToDisk();
      this.logger.log(`Strategy deleted: ${id}`);
    }
    return existed;
  }

  // ── Persistence ────────────────────────────────────────────────────

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        const raw = fs.readFileSync(STORAGE_FILE, 'utf-8');
        const arr: UserStrategyDto[] = JSON.parse(raw);
        for (const s of arr) {
          if (s.id) this.strategies.set(s.id, s);
        }
        this.logger.log(`Loaded ${this.strategies.size} user strategies from disk`);
      }
    } catch (err) {
      this.logger.warn(`Could not load user strategies: ${(err as Error).message}`);
    }
  }

  private persistToDisk(): void {
    try {
      if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
      }
      const data = JSON.stringify(this.findAll(), null, 2);
      fs.writeFileSync(STORAGE_FILE, data, 'utf-8');
    } catch (err) {
      this.logger.error(`Could not persist user strategies: ${(err as Error).message}`);
    }
  }
}
