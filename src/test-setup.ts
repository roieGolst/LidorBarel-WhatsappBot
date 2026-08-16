// Loads .env for the test run. Integration tests need DATABASE_URL to reach the
// local PostgreSQL started by `npm run db:up`; unit tests are unaffected.
import 'dotenv/config';
