# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An inbound-only, opt-in WhatsApp bot for Lidor Barel's real estate business: it
qualifies leads against a fixed spec, projects them into Monday.com, and books
appointments into Google Calendar. Cold outbound is deliberately out of scope.

## Environment & commands

**Node 24 is required** (`.nvmrc`). The default shell here is Node 22 — run `nvm use`
first or commands fail with `EBADENGINE` and vitest/tsc may misbehave.

```bash
nvm use                 # switch to Node 24 — do this first, every session
npm install
npm run db:up           # start local Postgres + Redis (Docker); REQUIRED for the test suite
npm run check           # the pre-commit gate: typecheck + lint + format:check + test
```

- **Run one test file:** `npx vitest run src/whatsapp/signature.test.ts`
- **Run tests matching a name:** `npx vitest run -t "invalid signature"`
- `npm run typecheck` · `npm run lint` · `npm run format` · `npm run build`
- **Migrations:** edit `src/db/schema.ts`, then `npm run db:generate` (writes SQL to
  `drizzle/`), then `npm run db:migrate`. Never hand-edit generated migration files.

Integration tests run against a **real** Postgres (not mocks) because the guarantees
being tested — unique constraints, upserts, cascades, checkpoint durability — live in
the database. They use a sibling `<db>_test` database, run serially (`fileParallelism:
false`), and truncate between cases. If `db:up` isn't running, they fail.

## Architecture

**PostgreSQL is the single source of truth; Monday.com is a projection of it, never the
reverse.** The projection can be rebuilt from Postgres at any time. Same principle for
LangGraph checkpoints: disposable execution state, rebuildable from `messages` +
`conversations`.

Request path for an inbound message:

```
Meta webhook ─▶ signature verify (raw body) ─▶ idempotent ingestion (Postgres)
             ─▶ [M3] LangGraph workflow ─▶ transactional outbox ─▶ Monday / Calendar / notify
```

- **Webhook signature** (`src/whatsapp/signature.ts`): Meta signs the *exact bytes* of
  the body, so `src/server.ts` installs a content-type parser that keeps `rawBody`
  alongside the parsed JSON. Verifying against a re-serialized object would never match.
  Comparison is constant-time.
- **Webhook status codes are deliberate** (`src/whatsapp/routes.ts`): 403 on bad
  signature, 503 when credentials are absent (fail closed), **200 on a validly-signed but
  unparseable body** — because it genuinely came from Meta and any error makes Meta
  redeliver forever. Ingestion runs synchronously *before* responding so a failure returns
  non-2xx and Meta retries; ingestion is idempotent (unique `provider_message_id`), so
  retries are safe.
- **Reply generation does NOT happen in the webhook** — an LLM call is too slow for a
  webhook and belongs in the workflow/queue.
- **LangGraph boundary (M3+):** the graph decides *what to say next within one
  conversation*; everything about *how to send it and who else to tell* (transport,
  Monday sync, follow-ups, opt-out enforcement) lives outside. `conversations.stage` is
  owned exclusively by application code — the LLM returns JSON only and never sets a
  stage, so a hallucinated transition is structurally impossible. Checkpoints live in a
  separate `langgraph` Postgres schema (see `src/workflow/checkpointer.ts`).

### Data & conventions worth knowing before editing

- **Config** (`src/config.ts`): one Zod-validated module, parsed once, **fails fast** at
  startup on missing/malformed values and **never echoes values** in errors (many are
  secrets). Meta/Anthropic vars are optional *as a group* so the app boots for testing
  without live credentials. Add new env vars in three places: the schema, `readEnv`, and
  `ENV_VAR_NAMES` — and document them in `.env.example`.
- **Repositories** (`src/db/repositories/*`) take a `DbClient` (pool *or* transaction),
  not `Database`, so they compose inside a caller's transaction. Multi-write operations
  (contact + conversation + message + window refresh) must commit as one unit.
- **Logging** (`src/logger.ts`): pino with redaction of `body`/`phone`/`text` etc.
  Transcripts and phone numbers are personal data and must not reach logs; read them via
  the (future) admin panel. `no-console` is an error — use the logger.
- **A new inbound from someone whose last conversation is in a terminal stage starts a
  fresh conversation** (`conversations.ts` `TERMINAL_STAGES`), not a reopen.

### TypeScript / lint gotchas

- **NodeNext ESM:** relative imports **must** end in `.js` (e.g. `import { x } from
  './config.js'`) even though the source is `.ts`. `verbatimModuleSyntax` +
  `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are on — expect to guard
  array/optional access.
- Type-aware ESLint is strict about async: `no-floating-promises`, `no-misused-promises`,
  `require-await` are errors, because a dropped promise in a webhook/queue system loses a
  customer's message silently.
- Tests are colocated as `*.test.ts` next to the code.

## Working discipline

- **One milestone per branch, one at a time.** Branches are named `milestone/N-<slug>`
  (e.g. `milestone/2-inbound-channel`, `milestone/3-conversation-workflow`), each built on
  the previous and reviewed before the next begins. Do not stack a new milestone's commits
  onto a prior milestone's branch.
- **The design is authoritative and already decided.** The implementation plan (v5) lives
  at `~/.claude/plans/i-m-building-an-ai-powered-elegant-newt.md`; the bot's behaviour
  (voice, screening questions, disqualification rules, objection handling) is defined by
  the Champions Chatbot Builder spec. Implement those — don't invent business rules.
- **Monday.com:** match columns/labels by **ID, never label text** (renames are safe, ID
  changes are not; several label IDs are non-intuitive). Write scope is the **לידים** and
  **פעילות** boards only. Monday's native Lead Ads integration must stay **disabled** or
  every submission double-creates items.
- Commit messages: concise imperative subject + a body explaining *why* (see history),
  ending with the `Co-Authored-By` trailer.
