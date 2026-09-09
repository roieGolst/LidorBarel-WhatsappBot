import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import pino from 'pino';
import { createDatabase } from './client.js';

/**
 * Applies pending migrations from `drizzle/` — the production counterpart of
 * `npm run db:migrate`.
 *
 * `drizzle-kit` is a development dependency and is not in the runtime image,
 * so production uses drizzle-orm's own migrator over the same SQL files (the
 * test harness in `testing.ts` has always done the same). Run before the app
 * starts on every deploy; applying an already-applied migration is a no-op.
 *
 * Deliberately needs only DATABASE_URL — not the full validated config — so a
 * schema can be migrated (or a restore verified) from a one-off container
 * without the rest of the environment present.
 */
async function main(): Promise<void> {
  const log = pino();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const db = createDatabase(url, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
    log.info('migrations applied');
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  pino().fatal({ err: error }, 'migration failed');
  process.exit(1);
});
