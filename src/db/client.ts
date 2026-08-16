import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getConfig } from '../config.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>;

/** Transaction handle, as passed to the `db.transaction()` callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Anything capable of running queries: the connection pool or a transaction.
 *
 * Repositories take this rather than `Database` so they compose inside a
 * transaction without casting. Several operations — recording an inbound
 * message, or writing an opt-out — must commit as a unit, and a repository that
 * insisted on the pool would silently run outside the caller's transaction.
 */
export type DbClient = Database | Transaction;

/**
 * Creates a database handle.
 *
 * Exported for tests, which need an isolated connection they can close. The
 * application uses {@link getDatabase} instead.
 */
export function createDatabase(connectionString: string, options?: { max?: number }) {
  const client = postgres(connectionString, {
    max: options?.max ?? 10,
    // Fail fast rather than queueing forever behind an unavailable database.
    connect_timeout: 10,
    // Postgres timestamps come back as Date objects; keep them that way.
    types: {},
    onnotice: () => {
      // Postgres NOTICE output is noise here (mostly "relation already exists"
      // during migrations) and would otherwise reach the logs unredacted.
    },
  });

  return Object.assign(drizzle(client, { schema }), {
    /** Closes the underlying connection pool. */
    close: () => client.end(),
  });
}

let cached: Database | undefined;

/** Returns the shared database handle, connecting on first use. */
export function getDatabase(): Database {
  cached ??= createDatabase(getConfig().databaseUrl);
  return cached;
}

/** Closes the shared handle. Used on graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  if (cached) {
    await cached.close();
    cached = undefined;
  }
}
