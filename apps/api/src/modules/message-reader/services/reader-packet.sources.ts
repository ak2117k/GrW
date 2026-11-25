/**
 * The two database reads the reader's data packet needs. A port, so the packet service stays free of
 * Prisma (the message_readings client is generated later); the message-reader repository implements it.
 */
export const READER_PACKET_SOURCES = Symbol('READER_PACKET_SOURCES');

export interface ChannelPost {
  /** ISO time the post arrived. */
  at: string;
  /** Raw post text. */
  text: string;
}

export interface ReaderPacketSources {
  /** That channel's posts received at or after `since`, newest first. */
  recentChannelPosts(channelId: string, since: Date): Promise<ChannelPost[]>;
  /** The IST session day's READ rows with CONFIRMED / CONTRADICTED MARKET-scope claims, newest first. */
  todayMarketNotes(sessionDate: string): Promise<unknown[]>;
}
