import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Admin request to designate WHICH connected account powers the shared
 * market-data feed (vault→market-feed bridge design §3.5). `userId` must be a
 * user that already has a `BrokerCredential`; the endpoint transactionally
 * clears any prior feed account and flags this one.
 */
export class SetFeedAccountDto {
  @IsString()
  @IsNotEmpty()
  userId: string;
}
