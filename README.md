# Lidor Barel — WhatsApp Lead Bot

An AI-powered WhatsApp bot for Lidor Barel's real estate business in Beer Sheva.

It **proactively contacts people who submitted the paid Meta campaign lead form
and consented to WhatsApp contact**, qualifies them against the screening
questions in the Chatbot Builder specification, creates and updates leads in
Monday.com, offers appointment slots, and books approved meetings into Google
Calendar. People who message first are handled by the same conversation engine.

**Cold outbound** — unsolicited messaging to a purchased or scraped list — is
deliberately out of scope. That is a different thing from the opt-in outreach
above, which is this product's primary purpose.

📄 **[docs/PRODUCT-REQUIREMENTS.md](docs/PRODUCT-REQUIREMENTS.md) is the source of
truth** for what this product does. See also
[implementation status](docs/IMPLEMENTATION-STATUS.md) and
[traceability](docs/TRACEABILITY.md).

## Status

The **inbound conversation engine is mature and well covered by tests**. The
**proactive outreach path — the core purpose — is not yet built.**

| Phase | Deliverable | Status |
|---|---|---|
| 0 | Alignment documents | Done |
| 1 | `leadgen` intake (receives leads, sends nothing) | Done |
| 2 | Consent gate + send-window enforcement | Next |
| 3 | Approved-template first contact | Not started |
| 4 | Follow-up scheduler (≤ 5 days) | Not started |
| 5 | Monday.com sync | Not started |
| 6 | Appointments and Calendar | Not started |
| 7 | Admin panel, simulation, hardening | Not started |

Already delivered: repo foundations, data layer, inbound WhatsApp channel with
idempotent ingestion, the LangGraph conversation workflow, opt-out enforcement,
the spec's opening sequence with interactive buttons and lists, and Meta Lead Ads
intake (leads are captured; nothing is sent yet).

Phases 3 onward depend on external items — Meta Business verification, lead-form
consent wording, and approved message templates. See
[IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md) §5.

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
phase breakdown — lives in the repository at [docs/plan-v5.md](docs/plan-v5.md).

Note its precedence rules: the **v5** section supersedes the earlier **v4**
"outbound removed from scope" section, and
[docs/PRODUCT-REQUIREMENTS.md](docs/PRODUCT-REQUIREMENTS.md) supersedes both.

It is updated whenever an implementation decision materially differs from it.

## Notable decisions

- **TypeScript is pinned to 5.9, not 7.x.** TypeScript 7 is released, but
  `typescript-eslint` does not yet support it (peer range `<6.1.0`). Type-aware
  linting catches floating promises, which in a webhook and queue system are a
  silent-data-loss class of bug, so it is worth more than being on the newest
  compiler. Revisit once `typescript-eslint` supports 7.x.
