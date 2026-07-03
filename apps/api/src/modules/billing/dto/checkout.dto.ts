import { IsIn } from 'class-validator';

/** The two plan-gated segments a user can subscribe to (separate subscriptions). */
export class CheckoutDto {
  @IsIn(['INTRADAY', 'SWING'])
  segment!: 'INTRADAY' | 'SWING';
}
