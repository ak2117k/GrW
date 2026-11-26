import { Module } from '@nestjs/common';
import { DESK_MANAGER_CONFIG, parseDeskManagerConfig } from './desk-manager.config';

/**
 * Desk manager (docs/superpowers/specs/2026-11-26-desk-manager-design.md). Providers are wired in plan Task 8;
 * until then the module only exposes its config, so importing it changes nothing.
 */
@Module({
  providers: [{ provide: DESK_MANAGER_CONFIG, useFactory: () => parseDeskManagerConfig(process.env) }],
  exports: [DESK_MANAGER_CONFIG],
})
export class DeskManagerModule {}
