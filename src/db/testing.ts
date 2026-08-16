import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { createDatabase, type Database } from './client.js';

/**
 * Integration-test support.
 *
 * These tests run against a real PostgreSQL instance rather than a mock. The
 * behaviour M1 needs to guarantee — unique constraints, partial indexes, upsert
 * semantics, cascade deletes — lives in the database, not in application code,
 * so a mock would verify nothing that matters.
 *
 * Start the database with `npm run db:up` before running the suite.
 */

/** Connection string for the test database, derived from DATABASE_URL. */
export function testDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'TEST_DATABASE_URL or DATABASE_URL must be set to run integration tests. ' +
        'Copy .env.example to .env and run `npm run db:up`.',
    );
  }

  if (process.env.TEST_DATABASE_URL) return base;

  // Derive a sibling `*_test` database so a test run can never truncate
  // development data.
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/^\//, '')}_test`;
  return url.toString();
}

/** Creates the test database if it does not already exist. */
async function ensureTestDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.replace(/^\//, '');

  // Connect to the default `postgres` database to issue CREATE DATABASE, which
  // cannot run inside the database being created.
  const admin = new URL(url);
  admin.pathname = '/postgres';

  const client = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const existing = await client`
      SELECT 1 FROM pg_database WHERE datname = ${dbName}
    `;
    if (existing.length === 0) {
      // Identifiers cannot be parameterized; dbName is derived from our own
      // configuration rather than user input.
      await client.unsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Connects to the test database, creating it and applying migrations if needed.
 *
 * Migrations run against the same files shipped to production, so this also
 * exercises that the generated SQL actually applies to an empty database.
 */
export async function setupTestDatabase(): Promise<Database> {
  const url = testDatabaseUrl();
  await ensureTestDatabaseExists(url);

  const db = createDatabase(url, { max: 1 });
  await migrate(db, { migrationsFolder: './drizzle' });
  return db;
}

/**
 * Removes all rows while leaving the schema intact.
 *
 * CASCADE handles foreign keys, and RESTART IDENTITY resets sequences so tests
 * cannot depend on ids left behind by an earlier test.
 */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(`
    TRUNCATE TABLE
      events,
      outbox,
      opt_outs,
      campaign_referrals,
      appointment_requests,
      messages,
      conversations,
      listings,
      properties,
      contacts
    RESTART IDENTITY CASCADE
  `);
}
