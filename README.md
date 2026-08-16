# Lidor Barel — Inbound WhatsApp Bot

An AI-powered WhatsApp bot for Lidor Barel's real estate business in Beer Sheva.

It handles **inbound, opt-in leads only** — people who message first or arrive
through Click-to-WhatsApp ads. The bot qualifies them against the screening
questions in the Chatbot Builder specification, creates and updates leads in
Monday.com, offers appointment slots, and books approved meetings into Google
Calendar.

Cold outbound outreach is deliberately **out of scope**. See
[the implementation plan](#implementation-plan) for the reasoning.

## Status

Milestone 0 of 9 — repository and foundations.

| # | Milestone | Status |
|---|-----------|--------|
| 0 | Repo and foundations | In progress |
| 1 | Data layer | Not started |
| 2 | Inbound WhatsApp channel | Not started |
| 3 | Conversation workflow (LangGraph) | Not started |
| 4 | Outbound sending and opt-out | Not started |
| 5 | Monday.com sync | Not started |
| 6 | Appointments and Calendar | Not started |
| 7 | Follow-ups | Not started |
| 8 | Admin panel | Not started |
| 9 | Simulation and hardening | Not started |

## Requirements

- **Node.js 24** (see `.nvmrc` — run `nvm use`)
- **Docker** with Compose, for local PostgreSQL and Redis

## Getting started

```bash
nvm use
npm install
cp .env.example .env    # then review the values
npm run db:up           # start PostgreSQL and Redis
npm run check           # typecheck, lint, format, test
npm run dev             # start the app
```

## Scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Start with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build |
| `npm run typecheck` | Type check without emitting |
| `npm run lint` | ESLint, including type-aware rules |
| `npm run format` | Apply Prettier |
| `npm test` | Run the test suite |
| `npm run check` | Everything above — the pre-commit gate |
| `npm run db:up` / `db:down` / `db:logs` | Manage local containers |

## Configuration

All configuration comes from environment variables, validated once at startup by
`src/config.ts`. The process exits immediately with a list of every problem if
anything is missing or malformed.

`.env.example` documents every variable. Copy it to `.env` — which is git-ignored
and must never be committed.

Two properties of the config module are deliberate and worth preserving:

- **Fail fast.** Bad configuration stops the process at boot, not at 2am the
  first time an unusual code path runs.
- **Never echo values.** Many of these variables are secrets. Validation errors
  report the variable name and the reason only, so a malformed connection string
  cannot leak a password into a log aggregator.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NODE_ENV` | no | `development` | `development` \| `test` \| `production` |
| `PORT` | no | `3000` | HTTP server port (webhooks + admin API) |
| `LOG_LEVEL` | no | `info` | Pino log level |
| `APP_TIMEZONE` | no | `Asia/Jerusalem` | Drives business hours, Shabbat handling, follow-up scheduling |
| `DATABASE_URL` | **yes** | — | PostgreSQL connection string |
| `REDIS_URL` | **yes** | — | Redis connection string |

`POSTGRES_*` and `REDIS_PORT` are consumed by `docker-compose.yml` for local
development only.

## Architecture

PostgreSQL is the **source of truth**. Monday.com is a projection of it, kept in
sync through a transactional outbox — a Monday outage can never interrupt a live
conversation, and the projection can be rebuilt from Postgres at any time.

Conversation orchestration uses LangGraph's Functional API, which provides
durable execution and human-in-the-loop interrupts. Two boundaries matter:

- **The LLM never changes conversation state.** It returns structured JSON;
  plain TypeScript decides every transition. A hallucinated stage is
  structurally impossible.
- **LangGraph decides what to say next within one conversation.** Everything
  about how to send it and who else to tell — WhatsApp transport, follow-up
  scheduling, Monday sync, Calendar writes — lives outside it.

Every outbound message passes a validator enforcing the specification's voice
rules (banned words, one question at a time, no unkeepable promises) before it
can reach WhatsApp.

## Logging and privacy

Contact details and conversation transcripts are personal data under Israel's
Privacy Protection Law. Message bodies and phone numbers are redacted from logs
by default; transcripts are read through the authenticated admin panel, not from
log output.

## Implementation plan

The full plan — architecture, data model, conversation flows, costs, risks, and
milestone breakdown — lives at
`~/.claude/plans/i-m-building-an-ai-powered-elegant-newt.md`.

It is updated whenever an implementation decision materially differs from it.

## Notable decisions

- **TypeScript is pinned to 5.9, not 7.x.** TypeScript 7 is released, but
  `typescript-eslint` does not yet support it (peer range `<6.1.0`). Type-aware
  linting catches floating promises, which in a webhook and queue system are a
  silent-data-loss class of bug, so it is worth more than being on the newest
  compiler. Revisit once `typescript-eslint` supports 7.x.
