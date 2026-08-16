// Loads .env for the test run. Integration tests need DATABASE_URL to reach the
// local PostgreSQL started by `npm run db:up`; unit tests are unaffected.
import 'dotenv/config';

// The logger is memoized from the process environment on first use, so the
// level has to be set before any module reaches for it. Without this, request
// logging from the server tests drowns out the test reporter's own output.
process.env.LOG_LEVEL = 'fatal';
