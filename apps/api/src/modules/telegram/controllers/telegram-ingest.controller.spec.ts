import { UnauthorizedException } from '@nestjs/common';
import { TelegramIngestController } from './telegram-ingest.controller';

function make(secret?: string) {
  const config = { get: jest.fn().mockReturnValue(secret) } as any;
  const ingest = { ingest: jest.fn().mockResolvedValue({ messageId: 'm', signalId: 's' }) } as any;
  const repo = { lastSeenByChannel: jest.fn().mockResolvedValue({}) } as any;
  return { c: new TelegramIngestController(ingest, repo, config), ingest, repo };
}

it('rejects when secret env unset', async () => {
  const { c } = make(undefined);
  await expect(c.receive('anything', {} as any)).rejects.toBeInstanceOf(UnauthorizedException);
});

it('rejects on wrong secret', async () => {
  const { c } = make('rightsecret');
  await expect(c.receive('wrongsecret!', {} as any)).rejects.toBeInstanceOf(UnauthorizedException);
});

it('accepts on correct secret', async () => {
  const { c, ingest } = make('sekret');
  await expect(c.receive('sekret', { a: 1 } as any)).resolves.toEqual({ messageId: 'm', signalId: 's' });
  expect(ingest.ingest).toHaveBeenCalled();
});

it('last-seen rejects when secret unset and returns map when authorized', async () => {
  const unset = make(undefined);
  await expect(unset.c.lastSeen('anything')).rejects.toBeInstanceOf(UnauthorizedException);
  const ok = make('sekret');
  await expect(ok.c.lastSeen('sekret')).resolves.toEqual({});
  expect(ok.repo.lastSeenByChannel).toHaveBeenCalled();
});
