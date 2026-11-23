/**
 * TEST-ONLY: the server's news-ai wire fixture — JSON the real NewsAiController produced
 * (apps/api/src/modules/news-ai/news-ai.contract.spec.ts writes and checks it). Imported raw so
 * the web tests read exactly what the server sends; nothing in the app imports this file.
 */
import raw from '../../../api/src/modules/news-ai/testing/news-ai.wire-fixture.json?raw';
import type { AiSentimentOverview, NewsAiBriefResponse, NewsAiReadsResponse, NewsAiRefreshResponse } from './newsAi';

export interface NewsAiWireFixture {
  brief: NewsAiBriefResponse;
  briefEmpty: NewsAiBriefResponse;
  refresh: NewsAiRefreshResponse;
  reads: NewsAiReadsResponse;
  overview: AiSentimentOverview;
}

/** A fresh deep copy per call, so a test can mutate its copy. */
export const wireFixture = (): NewsAiWireFixture => JSON.parse(raw) as NewsAiWireFixture;
