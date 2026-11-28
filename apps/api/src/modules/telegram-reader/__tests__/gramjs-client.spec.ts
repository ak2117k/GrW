import { Api } from 'telegram';
import { UpdateConnectionState } from 'telegram/network';
import { GramJsClientFactory } from '../client/gramjs-client';

/** No network: the inner TelegramClient is replaced before anything could connect. */
function client() {
  const c = new GramJsClientFactory().create(1, 'h'.repeat(32), '');
  const inner = (c as any).client;
  return { c, inner };
}

describe('GramJsClient', () => {
  it('connect() throws when GramJS resolves false (prod 2026-11-27: dead network → every request then hung)', async () => {
    const { c, inner } = client();
    inner.connect = jest.fn(async () => false);
    await expect(c.connect()).rejects.toThrow('network unreachable');
    inner.connect = jest.fn(async () => true);
    await expect(c.connect()).resolves.toBeUndefined();
  });

  it('onAnyUpdate counts real updates only, not connection-state pseudo-updates', () => {
    const { c, inner } = client();
    const handlers: Array<(u: unknown) => void> = [];
    inner.addEventHandler = jest.fn((h: (u: unknown) => void) => handlers.push(h));
    const seen = jest.fn();
    c.onAnyUpdate!(seen);
    handlers[0](new UpdateConnectionState(UpdateConnectionState.connected));
    handlers[0](new Api.UpdateNewChannelMessage({ message: new Api.MessageEmpty({ id: 1 }), pts: 1, ptsCount: 1 }));
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
