export default () => ({
  app: {
    port: parseInt(process.env.API_PORT || '3001', 10),
    host: process.env.API_HOST || 'localhost',
  },
  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/td_automation',
  },
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  rateLimit: {
    ttl: +(process.env.GLOBAL_RATE_TTL || 60000),
    limit: +(process.env.GLOBAL_RATE_LIMIT || 120),
  },
  angelOne: {
    apiKey: process.env.ANGEL_ONE_API_KEY || '',
    clientId: process.env.ANGEL_ONE_CLIENT_ID || '',
    password: process.env.ANGEL_ONE_PASSWORD || '',
    totpSecret: process.env.ANGEL_ONE_TOTP_SECRET || '',
  },
  trading: {
    paperTrading: process.env.PAPER_TRADING === 'true',
    maxDailyLoss: parseInt(process.env.MAX_DAILY_LOSS || '5000', 10),
    maxCapitalPerTrade: parseInt(process.env.MAX_CAPITAL_PER_TRADE || '200000', 10),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || '10', 10),
  },
  aiEngine: {
    url: process.env.AI_ENGINE_URL || 'http://localhost:5000',
    port: parseInt(process.env.AI_ENGINE_PORT || '5000', 10),
  },
});
