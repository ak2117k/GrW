import { Api } from 'telegram';
import { downloadOf } from '../client/gramjs-client';

/** Prod 2026-10-26/27: 128 "empty download" images — a PhotoSizeProgressive passed as an object. */
describe('downloadOf', () => {
  const photo = new Api.Photo({
    id: BigInt(1) as never, accessHash: BigInt(2) as never, fileReference: Buffer.from('r'), date: 0, dcId: 4,
    sizes: [
      new Api.PhotoSize({ type: 'm', w: 320, h: 320, size: 20_000 }),
      new Api.PhotoSizeProgressive({ type: 'y', w: 1280, h: 1280, sizes: [10_000, 60_000, 140_000] }),
    ],
  });
  const message = new Api.Message({ id: 42, peerId: new Api.PeerChannel({ channelId: BigInt(1) as never }), date: 0, message: '', media: new Api.MessageMediaPhoto({ photo }) });

  it('asks for a progressive size by its type string (GramJS ignores a PhotoSizeProgressive object)', async () => {
    const client = { downloadMedia: jest.fn(async () => Buffer.from('jpeg')) };
    const out = await downloadOf(client as never, message, 'y');
    expect(client.downloadMedia).toHaveBeenCalledWith(message, { thumb: 'y' });
    expect(out?.toString()).toBe('jpeg');
  });

  it('a size the photo does not have is not downloaded', async () => {
    const client = { downloadMedia: jest.fn(async () => Buffer.from('jpeg')) };
    expect(await downloadOf(client as never, message, 'w')).toBeNull();
    expect(client.downloadMedia).not.toHaveBeenCalled();
  });
});
