import { withQuietConsole } from './angel-one-adapter.service';

describe('withQuietConsole (the SDK prints every searchScrip match to stdout)', () => {
  it('mutes console.log during the call and restores it afterwards, even on error', async () => {
    const original = console.log;
    const spy = jest.fn();
    console.log = spy;
    try {
      await withQuietConsole(async () => { console.log('noise'); });
      expect(spy).not.toHaveBeenCalled();
      await expect(withQuietConsole(async () => { throw new Error('x'); })).rejects.toThrow('x');
      console.log('after');
      expect(spy).toHaveBeenCalledWith('after');
    } finally {
      console.log = original;
    }
  });

  it('overlapping calls restore the original only when the last finishes', async () => {
    const original = console.log;
    const spy = jest.fn();
    console.log = spy;
    try {
      let release!: () => void;
      const slow = withQuietConsole(() => new Promise<void>((r) => { release = r; }));
      await withQuietConsole(async () => undefined);
      console.log('still quiet');
      expect(spy).not.toHaveBeenCalled();
      release(); await slow;
      console.log('loud');
      expect(spy).toHaveBeenCalledWith('loud');
    } finally {
      console.log = original;
    }
  });
});
