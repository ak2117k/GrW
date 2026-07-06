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
    // TLS-only managed Redis (Upstash / ElastiCache in-transit) needs an actual
    // tls socket on the ioredis client. Presence of a tls object enables it;
    // undefined leaves plain TCP for local/dev. validate-boot-config asserts
    // REDIS_TLS==='true' in production. `{}` is enough — ioredis derives SNI
    // (servername) from host. Shared by Bull, market-feed pub/sub, and the
    // rate-limit store so every Redis consumer connects the same way.
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
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
  secrets: {
    provider: process.env.SECRETS_PROVIDER || 'local',
  },
  kms: {
    provider: process.env.KMS_PROVIDER || 'local',
    cmkId: process.env.KMS_CMK_ID || '',
  },
  billing: {
    // 'razorpay' (prod default) | 'fake' (test/offline). Tests run 'fake'.
    provider: process.env.BILLING_PROVIDER || 'razorpay',
    // Grace/dunning window (days) added to expiresAt after a paid cycle and
    // retained on a failed renewal until Razorpay's retries are exhausted.
    graceDays: +(process.env.BILLING_GRACE_DAYS || 3),
    // Public-launch kill switch: billing is built/tested behind this flag until
    // the SEBI/legal review lands (spec §11). Does not gate the test path.
    liveEnabled: process.env.LIVE_BILLING_ENABLED === 'true',
  },
});
