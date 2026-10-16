import {
  PRE_V9_FRESHCOUNT_LINE,
  PRE_V9_NEWS_FIELDS,
  V9_BLOCKS_INSERT,
  V9_FRESHCOUNT_LINE,
  V9_NEWS_EXIT_LINE,
  V9_NEWS_EXIT_LINE_TRIGGERS,
  V9_NEWS_FIELDS,
  V9_NEWS_READING_LINES,
} from '../prompts/sentinel-system-prompt';

/**
 * Test support only (news & events v2, Task D3): undo the news edits of a v9..v12 /
 * v2.6..v2.9 prompt, giving back its news-off twin (v9 → v7, v10 → v5, v11 → v6,
 * v12 → v8; cues-off likewise). Imported by the agent spec and the golden spec.
 */
export function undoNews(p: string, triggers: boolean): string {
  return p
    .replace(V9_NEWS_FIELDS, PRE_V9_NEWS_FIELDS)
    .replace(
      `${V9_FRESHCOUNT_LINE}\n${V9_NEWS_READING_LINES}${triggers ? V9_NEWS_EXIT_LINE_TRIGGERS : V9_NEWS_EXIT_LINE}\n`,
      `${PRE_V9_FRESHCOUNT_LINE}\n`,
    )
    .replace(V9_BLOCKS_INSERT, 'news.freshCount, ');
}
