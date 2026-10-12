import { validateBootConfig, BootConfigError } from '../../src/common/config/validate-boot-config';

const base = { JWT_SECRET: 's', ENCRYPTION_KEY: 'k'.repeat(32), DATABASE_URL: 'postgresql://x/db' };

describe('validateBootConfig', () => {
  it('passes in dev with the three core secrets', () => {
    expect(() => validateBootConfig({ ...base, NODE_ENV: 'development' } as any)).not.toThrow();
  });
  it('throws listing every missing core secret', () => {
    try { validateBootConfig({ NODE_ENV: 'development' } as any); fail('should throw'); }
    catch (e) {
      expect(e).toBeInstanceOf(BootConfigError);
      expect((e as Error).message).toContain('JWT_SECRET');
      expect((e as Error).message).toContain('ENCRYPTION_KEY');
      expect((e as Error).message).toContain('DATABASE_URL');
    }
  });
  it('in production requires WEB_ORIGIN + DB/AI/Redis TLS', () => {
    expect(() => validateBootConfig({ ...base, NODE_ENV: 'production' } as any)).toThrow(/WEB_ORIGIN|sslmode|AI_ENGINE_URL|REDIS_TLS/);
  });
  it('in production passes when fully configured', () => {
    expect(() => validateBootConfig({
      ...base, NODE_ENV: 'production', WEB_ORIGIN: 'https://app.example.com',
      DATABASE_URL: 'postgresql://x/db?sslmode=require', AI_ENGINE_URL: 'https://ai.example.com',
      REDIS_TLS: 'true', REDIS_THROTTLER: 'true', TELEGRAM_INGEST_SECRET: 'sekret',
    } as any)).not.toThrow();
  });
  it('rejects the public default key sentinel even if non-empty', () => {
    expect(() => validateBootConfig({ ...base, ENCRYPTION_KEY: 'td-automation-default-key-change-me', NODE_ENV: 'development' } as any))
      .toThrow(/default/i);
  });
  it('in production accepts a plaintext DATABASE_URL only with DATABASE_ALLOW_PLAINTEXT=true', () => {
    // The VPS compose stack reaches Postgres over its private Docker network (no TLS listener).
    const prod = {
      ...base, NODE_ENV: 'production', WEB_ORIGIN: 'https://app.example.com',
      DATABASE_URL: 'postgresql://grw@postgres:5432/grw?connection_limit=10', AI_ENGINE_URL: 'https://ai.example.com',
      REDIS_TLS: 'false', REDIS_ALLOW_PLAINTEXT: 'true', REDIS_THROTTLER: 'true', TELEGRAM_INGEST_SECRET: 'sekret',
    };
    expect(() => validateBootConfig(prod as any)).toThrow(/sslmode/);
    expect(() => validateBootConfig({ ...prod, DATABASE_ALLOW_PLAINTEXT: 'true' } as any)).not.toThrow();
  });
  describe('AI_ENGINE_URL in production', () => {
    const prod = {
      ...base, NODE_ENV: 'production', WEB_ORIGIN: 'https://app.example.com',
      DATABASE_URL: 'postgresql://x/db?sslmode=require',
      REDIS_TLS: 'true', REDIS_THROTTLER: 'true', TELEGRAM_INGEST_SECRET: 'sekret',
    };
    const check = (url: string | undefined) => () => validateBootConfig({ ...prod, AI_ENGINE_URL: url } as any);
    it('accepts the internal compose service over plain http', () => {
      expect(check('http://ai-engine:5000')).not.toThrow();
      expect(check('http://ai-engine')).not.toThrow();
    });
    it('accepts any https URL', () => {
      expect(check('https://x')).not.toThrow();
    });
    it('rejects any other plain-http host or lookalike', () => {
      for (const url of ['http://evil.example', 'http://ai-engine.evil.example', 'http://ai-engine:5000/path',
        'http://ai-engine:5000@evil.example', 'http://localhost:5000', undefined]) {
        expect(check(url)).toThrow(/AI_ENGINE_URL/);
      }
    });
  });
});
