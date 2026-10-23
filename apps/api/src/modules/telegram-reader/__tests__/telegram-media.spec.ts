import { chooseMedia, pickPhotoSize, PHOTO_MAX_BYTES } from '../services/telegram-media';

describe('chooseMedia — which post media is downloaded', () => {
  it('photo: the smallest size whose long side is at least 1000 px and at most 1 MB', () => {
    expect(
      pickPhotoSize([
        { type: 'm', w: 320, h: 240, bytes: 9_000 },
        { type: 'x', w: 800, h: 600, bytes: 60_000 },
        { type: 'y', w: 1280, h: 960, bytes: 140_000 },
        { type: 'w', w: 2560, h: 1920, bytes: 900_000 },
      ]),
    ).toMatchObject({ type: 'y' });
  });

  it('photo: no readable size within 1 MB -> the largest that fits; nothing within 1 MB -> skipped', () => {
    expect(
      pickPhotoSize([
        { type: 'm', w: 320, h: 240, bytes: 9_000 },
        { type: 'x', w: 800, h: 600, bytes: 60_000 },
        { type: 'y', w: 1280, h: 960, bytes: PHOTO_MAX_BYTES + 1 },
      ]),
    ).toMatchObject({ type: 'x' });
    expect(chooseMedia({ kind: 'photo', mimeType: 'image/jpeg', sizeBytes: null, sizes: [{ type: 'y', w: 1280, h: 960, bytes: 2_000_000 }] })).toMatchObject({ fetch: false });
    expect(chooseMedia({ kind: 'photo', mimeType: 'image/jpeg', sizeBytes: null, sizes: [{ type: 's', w: 90, h: 90, bytes: 2_000 }] })).toMatchObject({ fetch: false });
  });

  it('image documents up to 2 MB (jpeg / png / webp) are fetched whole', () => {
    expect(chooseMedia({ kind: 'image-document', mimeType: 'image/png', sizeBytes: 1_900_000, sizes: [] })).toMatchObject({ fetch: true, sizeType: null, mimeType: 'image/png' });
    expect(chooseMedia({ kind: 'image-document', mimeType: 'image/png', sizeBytes: 2_100_000, sizes: [] })).toMatchObject({ fetch: false, reason: expect.stringContaining('> 2 MB') });
    expect(chooseMedia({ kind: 'image-document', mimeType: 'image/tiff', sizeBytes: 100_000, sizes: [] })).toMatchObject({ fetch: false });
  });

  it.each(['video', 'sticker', 'gif', 'document', 'other'] as const)('%s is never fetched', (kind) => {
    expect(chooseMedia({ kind, mimeType: null, sizeBytes: 10_000, sizes: [] })).toMatchObject({ fetch: false });
  });
});
