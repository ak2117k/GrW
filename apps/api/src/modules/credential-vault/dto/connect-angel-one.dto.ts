import { IsNotEmpty, IsString } from 'class-validator';

/**
 * The five Angel One SmartAPI secrets a tenant submits to connect (TDA-005 §5.2).
 * `apiSecret` is the 5th field the legacy 4-field DTO was missing; it is stored
 * for order placement (TDA-011) even though SmartAPI `generateSession` does not
 * use it today.
 */
export class ConnectAngelOneDto {
  @IsString()
  @IsNotEmpty()
  apiKey: string;

  @IsString()
  @IsNotEmpty()
  apiSecret: string;

  @IsString()
  @IsNotEmpty()
  clientId: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  totpSecret: string;
}
