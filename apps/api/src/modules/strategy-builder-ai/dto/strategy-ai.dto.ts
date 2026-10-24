import { IsObject, IsOptional } from 'class-validator';
import type { BuilderStateInput } from '../domain/definition';

/**
 * The builder's state travels as one opaque object: normaliseBuilderState()
 * owns its validation (types, enums, length caps, operand vocabulary), so the
 * DTO only insists it is an object.
 */
export class StrategyCheckDto {
  @IsObject()
  state!: BuilderStateInput;
}

export class StrategyReviewDto extends StrategyCheckDto {
  /** Aggregates of the strategy's last backtest, if any — sanitised to known numeric keys. */
  @IsOptional()
  @IsObject()
  backtest?: Record<string, unknown>;
}

export class StrategySuggestDto extends StrategyCheckDto {}
