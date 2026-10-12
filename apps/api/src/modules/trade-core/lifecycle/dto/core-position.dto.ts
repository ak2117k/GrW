import { ValidateBy } from 'class-validator';
import { isReason } from '../../risk-wall/dto/core-risk.dto';

/** No userId: the global ValidationPipe({ whitelist: true }) strips it; the user comes from the token. */
export class ExitPositionDto {
  @ValidateBy({ name: 'isReason', validator: { validate: (v: unknown) => isReason(v), defaultMessage: () => '$property must say why, in 3 to 500 characters' } })
  reason!: string;
}
