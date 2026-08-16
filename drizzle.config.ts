import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // drizzle-kit runs outside the app, so it reads the environment directly
    // rather than through src/config.ts.
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
