import { toProcessMemory } from './health.memory';

describe('toProcessMemory', () => {
  it('converts bytes to whole megabytes', () => {
    expect(
      toProcessMemory({
        rss: 268_435_456,
        heapUsed: 134_217_728,
        heapTotal: 201_326_592,
        external: 8_388_608,
        arrayBuffers: 0,
      }),
    ).toEqual({ rssMb: 256, heapUsedMb: 128, heapTotalMb: 192, externalMb: 8 });
  });

  it('rounds rather than truncates', () => {
    const mem = toProcessMemory({
      rss: 1_572_864, // 1.5 MB
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      arrayBuffers: 0,
    });
    expect(mem.rssMb).toBe(2);
  });

  it('rounds down below the half-megabyte, so it is not a ceiling', () => {
    const mem = toProcessMemory({
      rss: 1_468_006, // ~1.4 MB
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      arrayBuffers: 0,
    });
    expect(mem.rssMb).toBe(1);
  });

  it('uses binary megabytes (1024*1024), not 1e6', () => {
    // 512 MiB is the Render ceiling; a decimal divisor would report 537.
    const mem = toProcessMemory({
      rss: 536_870_912,
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      arrayBuffers: 0,
    });
    expect(mem.rssMb).toBe(512);
  });
});
