import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the axios instance the service depends on.
vi.mock('./api', () => ({
  default: { get: vi.fn() },
}));

import api from './api';
import { getRejections, type RejectionsResponse } from './chartink';

const mockedGet = api.get as unknown as ReturnType<typeof vi.fn>;

function stubResponse(): RejectionsResponse {
  return {
    range: { from: '2026-05-18T00:00:00.000Z', to: '2026-05-18T23:59:59.999Z' },
    summary: {
      totalProcessed: 50,
      accepted: 12,
      rejected: 38,
      byKind: [
        { kind: 'no-direction', count: 20 },
        { kind: 'mtf-misaligned', count: 18 },
      ],
    },
    rejections: [
      {
        id: 'r1',
        processedAt: '2026-05-18T04:15:00.000Z',
        symbol: 'TCS',
        scanner: 'breakout-15m',
        kind: 'no-direction',
        reason: 'no MTF direction agreement',
        score: null,
        hitPrice: 3890.5,
        scoreBreakdown: null,
      },
    ],
  };
}

describe('chartink service — getRejections', () => {
  beforeEach(() => {
    mockedGet.mockReset();
  });

  it('calls GET /chartink/rejections and returns the response body', async () => {
    const stub = stubResponse();
    mockedGet.mockResolvedValueOnce({ data: stub });

    const result = await getRejections();

    expect(mockedGet).toHaveBeenCalledWith('/chartink/rejections', {
      params: {},
    });
    expect(result).toEqual(stub);
  });

  it('forwards from/to/kind/limit query params', async () => {
    mockedGet.mockResolvedValueOnce({ data: stubResponse() });

    await getRejections({
      from: '2026-05-18T00:00:00.000Z',
      to: '2026-05-18T23:59:59.999Z',
      kind: 'mtf-misaligned',
      limit: 25,
    });

    expect(mockedGet).toHaveBeenCalledWith('/chartink/rejections', {
      params: {
        from: '2026-05-18T00:00:00.000Z',
        to: '2026-05-18T23:59:59.999Z',
        kind: 'mtf-misaligned',
        limit: 25,
      },
    });
  });

  it('omits undefined params so the request stays clean', async () => {
    mockedGet.mockResolvedValueOnce({ data: stubResponse() });

    await getRejections({ kind: 'error' });

    expect(mockedGet).toHaveBeenCalledWith('/chartink/rejections', {
      params: { kind: 'error' },
    });
  });
});
