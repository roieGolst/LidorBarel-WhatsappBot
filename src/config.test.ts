import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from './config.js';

/** A minimal environment that satisfies every required field. */
function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: 'postgresql://lidor:pw@localhost:5432/lidor_bot',
    REDIS_URL: 'redis://localhost:6379',
    ...overrides,
  };
}

describe('parseConfig', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const config = parseConfig(validEnv());

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.timezone).toBe('Asia/Jerusalem');
  });

  it('coerces PORT to a number', () => {
    expect(parseConfig(validEnv({ PORT: '8080' })).port).toBe(8080);
  });

  it.each(['postgres://u:p@host:5432/db', 'postgresql://u:p@host:5432/db'])(
    'accepts %s as a database URL',
    (url) => {
      expect(parseConfig(validEnv({ DATABASE_URL: url })).databaseUrl).toBe(url);
    },
  );

  it('rejects a database URL with the wrong protocol', () => {
    expect(() => parseConfig(validEnv({ DATABASE_URL: 'mysql://u:p@host/db' }))).toThrow(
      ConfigError,
    );
  });

  it('rejects a malformed redis URL', () => {
    expect(() => parseConfig(validEnv({ REDIS_URL: 'not-a-url' }))).toThrow(ConfigError);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseConfig(validEnv({ PORT: '99999' }))).toThrow(ConfigError);
  });

  it('rejects an unknown log level', () => {
    expect(() => parseConfig(validEnv({ LOG_LEVEL: 'chatty' }))).toThrow(ConfigError);
  });

  it('reports every problem at once rather than only the first', () => {
    let error: unknown;
    try {
      parseConfig({ DATABASE_URL: 'nope', REDIS_URL: 'also-nope' });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toHaveLength(2);
  });

  it('names the environment variable, not the internal field, in errors', () => {
    let error: unknown;
    try {
      parseConfig(validEnv({ DATABASE_URL: 'nope' }));
    } catch (e) {
      error = e;
    }

    expect((error as ConfigError).problems[0]).toMatch(/^DATABASE_URL:/);
  });

  // Configuration values are frequently secrets. A validation failure must not
  // be the thing that puts a password into a log aggregator.
  it('never includes the offending value in the error message', () => {
    const secret = 'postgresql://user:sup3rs3cr3t@host:5432/db?sslmode=require-BROKEN';
    let error: unknown;
    try {
      parseConfig(validEnv({ REDIS_URL: secret }));
    } catch (e) {
      error = e;
    }

    expect((error as ConfigError).message).not.toContain('sup3rs3cr3t');
    expect((error as ConfigError).message).not.toContain(secret);
  });

  it('requires DATABASE_URL to be present', () => {
    expect(() => parseConfig({ REDIS_URL: 'redis://localhost:6379' })).toThrow(
      ConfigError,
    );
  });

  it('requires REDIS_URL to be present', () => {
    expect(() =>
      parseConfig({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' }),
    ).toThrow(ConfigError);
  });
});
