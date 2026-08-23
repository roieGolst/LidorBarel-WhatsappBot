# Lidor Barel WhatsApp Bot — Implementation Plan (v5)

> ## How to read this document
>
> This plan was written incrementally. It contains a **v4 section titled "outbound
> removed from scope"** followed by a **v5 section that partially reverses it**.
> Read both, and apply this precedence:
>
> 1. [PRODUCT-REQUIREMENTS.md](PRODUCT-REQUIREMENTS.md) — **highest authority**
> 2. The **"v5 change: Meta Lead Ads intake, and a consent gate"** section below
> 3. Everything else in this plan
>
> **What v4 actually removed** was *cold outbound* to the 48,000-record dataset —
> unsolicited messaging to people who never asked to be contacted. That remains
> permanently out of scope.
>
> **What v4 did not remove**, and what v5 explicitly reintroduced, is
> **business-initiated outreach to paid lead-form leads who consented to WhatsApp
> contact**. That is the product's *primary purpose*.
>
> Any sentence below describing the bot as "inbound-only" is superseded. The
> milestone ordering in §16 is also superseded — see
> [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) §4 for the current phase
> order, which puts proactive outreach before the Monday and Calendar layers.
>
> *Imported into the repository on 2026-08-23 from `~/.claude/plans/`, where it was
> not version-controlled alongside the code. Body below is verbatim apart from the
> title line.*

---


## Context

Lidor Barel is a solo real estate agent in Beer Sheva (4 years, 124 properties sold, 82% sold within two months). He needs an AI WhatsApp bot that handles **inbound leads only** — people who message him first or explicitly opt in, typically via paid Click-to-WhatsApp campaigns.

The bot receives inbound leads, qualifies them against the spec's screening questions, warms them through the defined conversation flow, creates and updates leads in Monday.com, offers appointment slots and books approved ones into Google Calendar, and honors opt-out requests.

The **Champions Chatbot Builder spec (9 sections) is the authoritative definition of the bot's behavior** — voice, screening questions, disqualification rules, objection handling, FAQs, follow-up cadence, and handoff conditions. This plan implements that spec and does not invent business rules on top of it.

---

## v4 change: outbound removed from scope

After reviewing the risks with Lidor, cold outreach to the 48,000-record dataset is **out of scope**. Removed entirely: campaign scheduling, cold-contact messaging, outbound follow-up policies, the unofficial (Baileys) channel, bulk dataset import, and warm-up/pacing machinery.

### Why this is the right call

| Risk in v3 | Status in v4 |
|---|---|
| WhatsApp ToS violation via unofficial client | **Gone** — official Cloud API only |
| Amendment 40 exposure (up to ₪1,000/message, class actions) | **Gone** — every contact initiated or opted in |
| Permanent number ban with no appeal | **Gone** — compliant platform use |
| Legal review blocking the entire project | **Reduced** to a routine privacy/PII review |
| ~200-day campaign timeline at 100 sends/day | **Gone** — no campaign |

It also resolves the conflict flagged at the outset of this project: the spec's opening message — *"תודה שהשארת פרטים לגבי הנכס שלך"* ("thanks for leaving details about your property") — assumes the person made contact first. Written for inbound, it now runs as inbound. No rewrite needed.

The dataset work is not wasted. Outbound can return later as a separate project with its own legal review and its own compliance design. Nothing in this architecture forecloses it.

---

## v5 change: Meta Lead Ads intake, and a consent gate

The real funnel is a **Meta Lead Ads form**, not only Click-to-WhatsApp. Where this
section conflicts with anything below, this section wins.

### The funnel

A paid Meta campaign runs a lead form asking:

1. *Is your property ready to be listed, or are you still exploring?* → `מוכן` / `לא בטוח`
2. *When are you planning to sell?* → `מיידי` / `בתוך חודש` / `עדיין בודק מחירים`
3. Full name, phone, email + consent

Then one of two paths:

| Path | Trigger | Messaging position |
|---|---|---|
| **(a)** | Prospect clicks Click-to-Chat and messages first | User-initiated. 24h service window open. Free-form. |
| **(b)** | Prospect never opens WhatsApp; bot reaches out after a **15–30 min grace period** | **Business-initiated. Requires an approved template and valid opt-in.** |

The grace period exists so the bot does not talk over someone who is already
opening the chat themselves.

### Consent is a hard gate on path (b)

The live form currently collects only a **Privacy Policy checkbox**. That is very
likely insufficient for both Meta's opt-in policy (which requires telling the
person they will receive WhatsApp messages from this specific business) and
Israeli Amendment 40 (which requires explicit consent for commercial messages).

**Therefore:**

- `contacts.consent_status` gates every proactive send. Leads carrying only
  privacy-policy consent are marked `PRIVACY_POLICY_ONLY` and **path (b) refuses
  to send to them** — enforced in code, not by policy.
- Path (a) is unaffected: the prospect messaged first, so no opt-in question arises.
- Consent provenance is stored per lead: text version, timestamp, form ID, source.
- Go-live for path (b) is blocked until the form carries a separate, visible line
  naming WhatsApp and the business, e.g.
  `אני מאשר/ת לקבל הודעות וואטסאפ מלידור בראל תיווך נדל״ן`.

This lets path (a) ship immediately while (b) waits on the form.

### Lead creation: the bot owns it

The bot subscribes directly to Meta's **leadgen webhook**, writes to PostgreSQL,
then creates the Monday item. Single writer, no race, no polling, and Monday stays
a pure projection.

> **Monday's native Lead Ads integration must NOT be enabled.** If it is, both it
> and the bot will create items for every submission.

Click-to-Chat messages are matched back to their form lead **by phone number**, so
E.164 normalization (`0533374203` → `+972533374203`) is correctness-critical and
is built with tests in M1.

### Screening shortens to two questions

The form already answers spec Q1 and Q3, and those answers map exactly onto
Lidor's existing columns. The bot therefore asks only **Q2 (neighborhood)** and
**Q4 (currently marketed)**, confirming the form answers rather than re-asking —
which fits the spec's "one question at a time, don't flood them" rule far better
than the original four-question flow.

### Monday integration — the real board

Lidor runs a working CRM. The bot **integrates with it; it does not redesign it.**

Write scope: **לידים** (leads) and **פעילות** (activities) only.

| Purpose | Board | Column |
|---|---|---|
| Lead status | לידים `1879864606` | `lead_status` |
| Lead source | לידים | `color_mm69jtnb` — `וואטסאפ בוט` when the bot creates the lead |
| Q1 intent | לידים | `color_mm692wg7` מוכנות מכירה |
| Q3 timeline | לידים | `color_mm699p5k` מועד מכירה רצוי |
| Phone / email | לידים | `lead_phone` / `lead_email` |
| Last interaction | לידים | `date__1` |
| Gender | לידים | `color_mkp8eq7j` מין |
| Appointments | פעילות `1879864604` | type `פגישת ייעוץ`, linked via `board_relation_mkpcs6ky`, with the existing Google Calendar integration column |

### Verified column mapping — לידים board `1879864606`

Confirmed against the live board on 2026-08-17. **These IDs are authoritative for
M5.** The bot matches on label **ID**, never label text, so renaming a label in
Monday is safe but changing its ID is not.

| Purpose | Column ID | Type |
|---|---|---|
| Lead name | `name` | name |
| Stage | `lead_status` | status |
| Lead source | `color_mm69jtnb` | status |
| Q1 — intent to sell | `color_mm692wg7` | status |
| Q2 — neighborhood | `dropdown_mm6ah57b` | dropdown |
| Q3 — timeline | `color_mm699p5k` | status |
| Q4 — currently marketed | `color_mm6aapxr` | status |
| Phone | `lead_phone` | phone |
| Email | `email_mm6aack2` | email |
| Gender | `color_mkp8eq7j` | status |
| Property details (free text) | `long_text_mm6a2mry` | long_text |
| Last interaction | `date__1` | date |
| Created on | `date_mm6apc14` | date |
| Assigned to | `multiple_person_mkpbact1` | people |

**Label IDs** (note several are not in intuitive order — match by ID):

- `lead_status`: `2`=ליד חדש · `14`=ממתין לשיחה · `0`=ממתין לפגישה ייעוץ ·
  `1`=ליד מוצלח (לקוח) · `3`=ליד ללא מענה · `4`=ליד לא מתאים ·
  `6`=ביקש להפסיק · `5`=חסר מידע
- `color_mm69jtnb` (source): `6`=וואטסאפ בוט · `0`=ממומן · `2`=דף נחיתה ·
  `4`=אורגני · `3`=פה לאוזן · `1`=פגישות
- `color_mm692wg7` (Q1): `1`=מוכן · `0`=לא בטוח / עדיין בודק · `2`=לא מעוניין למכור
- `color_mm699p5k` (Q3): `2`=מיידי · `0`=בתוך חודש · `1`=עייו בודק מחירים · `3`=אין דחיפות
- `color_mm6aapxr` (Q4): **`1`**=לא · **`0`**=כן, באופן פרטי · `2`=כן, עם מתווך
- `color_mkp8eq7j` (gender): `0`=נקבה · `1`=זכר
- `dropdown_mm6ah57b` (neighborhood): `1`–`10` = נווה זאב, נחל עשן, רמות, א, ב, ג, ד, ה, ו, ט

**Disqualification triggers**, mapping onto `disqualification_reason`:

| Monday value | Reason |
|---|---|
| `color_mm692wg7` = `2` (לא מעוניין למכור) | `not_selling` |
| `color_mm699p5k` = `3` (אין דחיפות) | `no_urgency` |
| `color_mm6aapxr` = `2` (כן, עם מתווך) | `exclusive_with_other_agent` |

---

**Original schema-addition request** (completed 2026-08-17 — retained for context):

1. לידים: new status column `משווק כרגע` → `לא` / `כן, באופן פרטי` / `כן, עם מתווך` (spec Q4)
2. לידים: new dropdown column `שכונה` (spec Q2), with the specification's list:
   `נווה זאב`, `נחל עשן`, `רמות`, `א׳`, `ב׳`, `ג׳`, `ד׳`, `ה׳`, `ו׳`, `ט׳`
   — **corrected**: an earlier revision of this plan omitted this. Write scope is
   לידים + פעילות only, and לידים has no neighborhood column, so without it the
   answer to Q2 has nowhere to go. The existing `שכונה` on נכסים is out of scope
   and carries only 4 values, none of which match the specification's list except
   נחל עשן.
3. לידים: new long-text column `פרטי נכס` for free-form property details gathered
   in conversation (street, rooms, condition). Property records are not created,
   so this is where that context lives until a lead converts.
4. לידים `color_mm692wg7`: add label `לא מעוניין למכור` (disqualifier)
5. לידים `color_mm699p5k`: add label `אין דחיפות` (disqualifier)
6. לידים `lead_status`: add `ליד לא מתאים` and `ביקש להפסיק`
7. לידים `color_mm69jtnb`: add `וואטסאפ בוט`

`נכסים` is out of write scope — its `איש קשר` relation points at `לקוחות`, not
`לידים`, and widening it would disturb a board Lidor actively uses. Property
details live on the lead until it converts.

### Handoff: the bot promises a call

A number registered on the Cloud API **cannot be used in the WhatsApp app**, so
Lidor cannot open a chat and continue typing. Handoff therefore means:

1. Bot sends the spec's handoff message (*"אני מעביר עכשיו הכול ללידור…"*).
2. Bot notifies Lidor with the lead summary and stops replying.
3. Lidor phones the person from his own number.

This matches the spec's own wording (*"יחזור אליך בהקדם"*) and keeps the admin
panel a **monitoring tool, not an inbox** — M8 does not need a live send box,
read state, or agent presence. If Lidor later wants to continue conversations in
WhatsApp himself, that is a separate phase with its own scope.

### After hours: the bot keeps working

The spec's after-hours message was written for a human. A bot does not sleep, and
refusing to talk at 22:00 wastes the moment of interest — the lead simply goes to
a competitor who answers.

So the bot **screens and qualifies at any hour**. Business hours apply only at the
handoff point, where the spec's after-hours message is used to set expectations
about when Lidor will call back — rather than as a conversation stopper. Follow-up
scheduling remains business-hours aware and still never runs on Shabbat.

### Hebrew grammatical gender

Hebrew conjugates by gender, and the spec's messages are masculine-default
(*"אם **תקבל** הצעה…"*), which reads as careless to a female owner and undercuts
the "sounds like a senior agent" requirement.

The bot opens **gender-neutral**, infers gender from the name and the person's own
writing, writes it to `color_mkp8eq7j`, and conjugates correctly thereafter. Low
confidence stays neutral rather than guessing.

---

## Confirmed decisions carried forward

| Area | Decision |
|---|---|
| Channel | **Official WhatsApp Business Cloud API**, single number |
| Orchestration | LangGraph TypeScript, Functional API |
| Source of truth | PostgreSQL. Monday.com is a projection |
| Data model | Contacts / Properties / Listings / Conversations / Messages |
| Qualification | Spec rules only. No invented scoring |
| LLM | Returns JSON only; application code owns all transitions |
| Validation | Pre-send validator enforcing the spec's voice rules |
| Appointments | Internal PENDING hold; Calendar event only after Lidor approves |
| Admin panel | Ships in V1, before pilot |
| Runtime | Node.js 24 LTS |
| Ops | Self-maintained, cost-optimized |

---

## 1. WhatsApp integration — Cloud API

One number: **the dedicated number already purchased**, registered on the Cloud API. Lidor's personal number stays in the normal WhatsApp app for human handoff — a number registered on Cloud API cannot be used in the consumer app, so this separation is required, not optional.

### Messaging windows — the constraint that shapes follow-ups

| Window | Opens when | Duration | Cost |
|---|---|---|---|
| Free entry point | User arrives via Click-to-WhatsApp ad | **72 hours** | All messages free |
| Customer service | Any user message | 24 hours | Non-template messages free |
| Outside any window | — | — | **Approved template required, billed** |

**This directly constrains the spec's follow-up rule** (5 messages, 1 day apart):

- Follow-up #1 usually lands inside an open window → free-form, LLM-generated, full voice fidelity.
- Follow-ups #2–#5 land **outside** the window → each requires a **pre-approved template**. The LLM cannot freely author these.

Design consequence: a small set of approved templates with parameter substitution (name, neighborhood, property reference) covers the later follow-ups. The moment the contact replies to any template, a fresh 24-hour window opens and free-form LLM conversation resumes. Templates must be drafted in Lidor's voice, checked against the spec's banned-word list, and submitted for approval **early** — approval takes time and is on the critical path.

### Channel interface

A thin `WhatsAppChannel` interface is retained — not for multi-provider support, but so the workflow can be tested without live Meta calls and so transport concerns stay out of the conversation logic.

```ts
interface WhatsAppChannel {
  sendFreeForm(to: E164, message: OutboundMessage): Promise<SendResult>
  sendTemplate(to: E164, template: TemplateRef, params: TemplateParams): Promise<SendResult>
  windowState(conversationId: string): Promise<WindowState>  // FREE_ENTRY | SERVICE | CLOSED
  health(): ChannelHealth
}
```

`windowState()` is what the workflow consults before deciding whether a free-form reply is even legal. Implementations: `CloudApiChannel`, `FakeChannel` (tests/simulation).

### Inbound handling

- Webhook endpoint with Meta signature verification.
- **CTWA referral payload captured** on ad-originated messages (ad id, source URL, headline) — genuine provenance for every lead, and the basis for attributing leads to campaigns.
- Media (voice notes, images) received and stored; the spec's flow expects people to send property photos.
- Delivery and read receipts recorded against `messages`.

---

## 2. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Node.js 24 LTS** | Current LTS. LangGraph needs Node 20+/TS 5.4+ — satisfied. |
| Language | TypeScript 5.4+ | Shared types across workflow, channel, admin. |
| Orchestration | **`@langchain/langgraph`** — Functional API | Durable execution, checkpointing, interrupts. Ordinary TS control flow. |
| Checkpointer | **`@langchain/langgraph-checkpoint-postgres`** (v1.0.1) | Same Postgres we already run. `MemorySaver` is dev-only. |
| LLM client | **`@anthropic-ai/sdk`** directly, inside tasks | Explicit `cache_control` and exact token accounting. |
| HTTP | Fastify | Webhooks + admin API. |
| DB | **PostgreSQL 16 — source of truth** | Relational integrity; JSONB for extracted data; transactional outbox. |
| ORM | Drizzle | SQL-transparent, easy to maintain solo. |
| Queue | BullMQ on Redis | Follow-up delays, outbox delivery, retries. Outside LangGraph. |
| Admin | React + Vite SPA, served by Fastify | Deliberately boring. Session auth. |
| Hosting | Hetzner VPS + Docker Compose | Persistent process for queues and checkpointer. |
| Observability | Pino, Sentry, Healthchecks.io | Free/cheap at this scale. |

---

## 3. Architecture

```
   Click-to-WhatsApp ad ─┐
   Direct message ───────┼──▶ Meta Cloud API ──▶ Webhook (signature verified)
   Website / social ─────┘                              │
                                                        ▼
                                          ┌──────────────────────────┐
                                          │  Inbound handler         │
                                          │  dedup, DNC check,       │
                                          │  referral capture        │
                                          └────────────┬─────────────┘
                                                       ▼
        ╔══════════════════════════════════════════════════════════╗
        ║   LangGraph Functional API workflow                       ║
        ║   thread_id = conversation.id                             ║
        ║                                                           ║
        ║   task: classifyAndExtract   (Claude → JSON)              ║
        ║   task: decideTransition     (plain TS, no LLM)           ║
        ║   task: generateReply        (Claude)                     ║
        ║   task: validateReply        (regen loop)                 ║
        ║   task: persistTurn          (Postgres + outbox)          ║
        ║   interrupt(): appointment approval / manual handoff      ║
        ╚═══════════════════════┬══════════════════════════════════╝
                                ▼
                  ┌───────────────────────────────┐
                  │  PostgreSQL — source of truth │
                  └──────────────┬────────────────┘
                                 ▼
              ┌──────────────┐   ┌──────────────────┐
              │ Outbox worker│──▶│ Monday.com       │ (projection)
              │ (BullMQ)     │──▶│ Google Calendar  │ (post-approval)
              └──────────────┘──▶│ Lidor notify     │
                                 └──────────────────┘
```

**Inside LangGraph:** per-conversation turn orchestration, checkpointed state, LLM step retries, human-in-the-loop interrupts.

**Outside LangGraph:** WhatsApp transport, follow-up scheduling, Monday sync, Calendar writes, opt-out enforcement, admin panel, infrastructure.

Boundary rule: **LangGraph decides what to say next within one conversation. Everything about how to send it and who else to tell lives outside.**

---

## 4. Data model

```
contacts            id, phone (unique, E.164), name,
                    consent_status, consent_source, consent_recorded_at,
                    entry_point,                    -- CTWA | DIRECT | WEBSITE | REFERRAL
                    do_not_contact, dnc_reason, dnc_at,
                    created_at, updated_at

properties          id, normalized_address (dedup key), street, neighborhood,
                    city, property_type, rooms, size_sqm, floor

listings            id, property_id, contact_id,
                    source, source_url, external_listing_id,
                    listing_date, asking_price, status,
                    first_seen_at, last_seen_at, raw_payload jsonb

conversations       id, contact_id, listing_id (nullable),
                    stage, status, qualified (nullable),
                    priority_score (nullable), extracted jsonb,
                    window_state, window_expires_at,
                    monday_item_id, last_inbound_at, last_outbound_at,
                    followup_count, next_followup_at, handoff_at, error_state

messages            id, conversation_id, direction, body,
                    media_type, media_url,
                    provider_message_id, delivery_status,
                    template_ref (nullable),        -- set when sent as template
                    llm_model, input_tokens, output_tokens,
                    cache_read_tokens, cost_usd, error, created_at

appointment_requests id, conversation_id, proposed_slots jsonb, selected_slot,
                     status (PENDING|APPROVED|REJECTED|EXPIRED),
                     hold_expires_at, google_event_id

campaign_referrals  id, contact_id, ad_id, source_url, headline, received_at

outbox              id, aggregate_type, aggregate_id, event_type, payload,
                    attempts, status, last_error

opt_outs            phone (unique), reason, source, created_at
events              append-only audit of every stage transition
```

Plus LangGraph's checkpoint tables, created by `PostgresSaver.setup()` in a **separate `langgraph` schema** so the boundary is visible in the database itself.

**Why the entity split survives without the dataset.** An inbound lead is still a person talking about a specific property, and the spec's screening questions (neighborhood, timeline, currently-marketed) are all property-scoped facts. One owner may enquire about more than one property, and may return months later about a different one. `listings` is now populated from the conversation and from CTWA referral data rather than from a scrape — lighter, but structurally the same, and it keeps "which property is this conversation about?" answerable.

`campaign_referrals` gives Lidor per-ad lead attribution, which matters when the whole funnel is paid.

**Opt-out** remains a separate global table checked before every outbound send, so it survives any change to contact records.

---

## 5. The LangGraph workflow

### 5.1 Shape

One `entrypoint` per conversation turn, `thread_id = conversation.id`. Screening progression is ordinary TypeScript inside the entrypoint — no graph DSL.

```ts
const conversationTurn = entrypoint(
  { name: 'conversationTurn', checkpointer },
  async (input: TurnInput) => {
    const analysis  = await classifyAndExtract(input)      // Claude → JSON
    const decision  = decideTransition(analysis, input)    // plain TS, no LLM
    if (decision.needsApproval) {
      const approval = await interrupt({ kind: decision.approvalKind, decision })
      // resumes here after Lidor acts in the admin panel
    }
    const draft     = await generateReply(decision)        // Claude
    const validated = await validateReply(draft, decision) // regen loop
    await persistTurn(decision, validated)                 // Postgres + outbox
    return validated
  }
)
```

`task()` wraps each step, so retries and checkpoints are per-step: a crash between `generateReply` and `persistTurn` resumes without re-billing the generation or double-sending.

**The LLM never sets stage.** `classifyAndExtract` returns JSON only:

```ts
{
  intent: 'ANSWER' | 'OBJECTION' | 'FAQ' | 'OPT_OUT' | 'OFF_TOPIC' | 'UNCLEAR',
  confidence: number,
  extracted: { sell_intent?, neighborhood?, timeline?, currently_marketed?, ... },
  needs_escalation: boolean
}
```

`decideTransition` is pure TypeScript with no model call. A hallucinated stage is structurally impossible. Low confidence routes to a clarifying question or escalation rather than a guessed transition.

### 5.2 State duality — the rule that keeps this safe

| | LangGraph checkpoint | Postgres business tables |
|---|---|---|
| Holds | Workflow execution position, in-flight step, interrupt status, message window | Stage, qualified, extracted fields, contact/listing linkage, full history |
| Authority | Execution state only | **Source of truth for every business fact** |
| If lost | Rebuildable from `messages` + `conversations` | Not rebuildable |
| Read by | The workflow, mid-turn | Admin, Monday sync, reporting, everything else |

**Rules:**
1. Every business-meaningful transition is committed to Postgres inside `persistTurn`, transactionally, with its outbox event.
2. Nothing outside the workflow reads the checkpoint to answer a business question.
3. Checkpoints are **disposable**; the rebuild path is tested (§13), not assumed.
4. `conversations.stage` is the only stage anyone outside the workflow may read.

### 5.3 Stages

```
NEW (first inbound) → ENGAGED
        ▼
  SCREENING_Q1   intent to sell
  SCREENING_Q2   neighborhood
  SCREENING_Q3   timeline
  SCREENING_Q4   currently marketed
        │
   ┌────┴─────┐
   ▼          ▼
QUALIFIED  DISQUALIFIED
   ▼
APPOINTMENT_PROPOSED → APPOINTMENT_PENDING → APPOINTMENT_CONFIRMED → HANDED_OFF

Terminal from any stage: OPTED_OUT, ERROR
Dormant: AWAITING_REPLY (drives follow-ups)
```

### 5.4 Interrupts

- **Appointment approval** — workflow parks at `APPOINTMENT_PENDING`; Lidor approves in the admin panel; the thread resumes via `Command({ resume })` and only then is the Calendar event written.
- **Manual handoff** — an operator can pause a conversation, intervene, then resume or terminate.

Both survive process restarts.

### 5.5 Validation

`validateReply` enforces the spec before anything is sent: banned words (`מבצע`, `זול`, `אני מבטיח`, `דחוף`, `בטוח`…), one question at a time, message length, tone, no unkeepable promises. On violation it regenerates once with the violation named, then falls back to a pre-written safe variant.

**Defense in depth:** the channel adapter re-asserts the banned-word check at the transport boundary, and **approved templates are validated at authoring time** against the same list.

### 5.6 Qualification — spec rules only

**Disqualify when** the contact is not planning to sell in the near future, is already exclusive with another agent (Q4 = "yes, with an agent"), or is unwilling to cooperate. Disqualified contacts receive the spec's polite closing message and are not pursued further.

**Otherwise qualified.** Qualification is a boolean derived from the spec's stated rules and is the source of truth.

`priority_score` exists in the schema but is **nullable and unpopulated in V1** — ordering only, never gating. Any formula needs Lidor's explicit approval before being enabled.

---

## 6. Follow-ups and opt-out

### Follow-up policy

The spec's rule applies as written, since it was authored for exactly this audience: **5 messages, 1 day apart, stopping when a meeting is booked or the contact asks to stop.**

Execution respects the messaging windows (§1):

| Follow-up | Typical window | Mechanism |
|---|---|---|
| #1 | Often inside 24h / 72h window | Free-form, LLM-generated |
| #2–#5 | Outside window | Pre-approved template + parameters |

Any reply to a template reopens a 24-hour window and returns the conversation to free-form. `next_followup_at` in Postgres is authoritative so the schedule survives a Redis flush. Follow-ups cancel immediately on any inbound message, appointment request, opt-out, or disqualification, and are business-hours aware (never Shabbat; the spec's after-hours message covers off-hours contact).

### Opt-out

- Detected by the classifier (`intent: OPT_OUT`) across varied and indirect phrasings, plus a keyword fast-path that does not depend on the LLM.
- Writes to `opt_outs` and sets `do_not_contact` — checked before **every** outbound send, including templates and follow-ups.
- Cancels all scheduled follow-ups immediately.
- Acknowledged once, politely, then silence.
- Irreversible without explicit re-opt-in recorded with source and timestamp.

---

## 7. LLM tiering and cost tracking

**Default `claude-haiku-4-5`** for classification, extraction, and straightforward replies — most turns.

**Escalate to `claude-sonnet-5`** when confidence is low, an objection is detected, free text goes off-script, frustration is detected, an FAQ doesn't match, or the validator has already rejected one attempt.

The spec content (voice rules, banned words, FAQs, objection handling, success stories) is a stable ~4k-token system prompt marked with `cache_control`, costing roughly a tenth of a fresh read per turn — the reason model calls use the Anthropic SDK directly rather than a wrapper.

**Cost tracking from day one:** `messages` stores `llm_model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd` per call, aggregated per conversation and per day in the admin panel.

---

## 8. Monday.com — a projection, never the source of truth

**Creation timing:** every lead is inbound and opt-in, so the Monday item is created **on the first inbound message**. These are paid-for leads and Lidor should see them immediately.

**Board redesign:**

| Group | Columns |
|---|---|
| New / Engaged | Name, Phone, Property address, Neighborhood, Asking price, Entry point, Ad source |
| Qualified | + Intent, Timeline, Currently marketed, Qualified at |
| Meeting Pending | + Proposed slots, Selected slot, Approval status |
| Disqualified | + Reason |
| No Response | + Follow-ups sent, Last contact |

Plus on every item: Stage, Status, Last inbound, Last outbound, Transcript link.

**Sync:** transactional outbox — `persistTurn` writes the event in the same transaction as the state change; a worker delivers with exponential backoff. **A Monday outage cannot interrupt or break a live conversation.** Idempotent via stored `monday_item_id`, dedup by phone, updates batched to respect Monday's complexity budget. Postgres can rebuild the projection at any time; the reverse is never relied on.

---

## 9. Appointments

1. Bot reads Lidor's Google Calendar **free/busy only** (read-only scope).
2. Offers 2–3 slots inside working hours (Sun–Thu 8:00–20:00, Fri 8:00–14:00, never Shabbat).
3. Contact selects one → `appointment_requests` row with `status = PENDING` and an internal **slot hold** (`hold_expires_at`). The workflow parks on `interrupt()`. No Calendar write yet.
4. Lidor approves in the admin panel → thread resumes → **only then** is the Calendar event created.
5. Hold expiry releases the slot and notifies the contact.

---

## 10. Admin panel — V1, before the pilot

**Control** — global pause (stop the bot replying) · manual handoff · mark DNC · **approve/reject appointment requests** (resumes interrupted threads)
**Visibility** — active conversations · full transcripts · search by phone · queue status · error monitoring · interrupted-thread list · template approval status
**Metrics** — inbound lead count · reply rate · qualification rate · opt-out rate · LLM cost per conversation and per day · per-ad attribution from `campaign_referrals`

React + Vite SPA behind session auth, served by Fastify. An operations tool, not a product surface.

---

## 11. Security and compliance

Secrets in env vars, never committed. Postgres and Redis bound to the Docker network only. Cloud API webhooks verified via Meta's signature header. Admin panel authenticated, no public write endpoints.

**PII:** contacts, transcripts, and property details are personal data under Israel's Privacy Protection Law. Retention policy, deletion on request, and encrypted backups are required. This is a routine privacy review rather than the blocking legal question v3 carried — every contact here initiated the conversation or opted in.

Alerts on: webhook failures, template rejection, delivery-rate drop, queue depth, outbox failures, LLM error rate, stuck interrupted threads.

---

## 12. Costs

### Pricing, verified against Meta's official documentation

- Per **delivered template message** since 1 July 2025, by category and recipient country.
- **Non-template messages inside the customer service window are free, with no announced end date.**
- **Click-to-WhatsApp ads open a 72-hour free entry point window** — all messages free.
- Utility templates are free inside an open service window; marketing templates always bill.
- 1 Oct 2026 brings market rate adjustments and volume-tier webhooks — not a service-reply charge.

**Still open:** Israel's per-message rate is not in the public docs; read it from the rate card in Business Manager to finalize template costs.

### Development

| Phase | Scope | Hours |
|---|---|---|
| 1 | Data layer: contacts/properties/listings/conversations/messages, dedup | 20–28 |
| 2 | Cloud API channel: webhooks, media, windows, templates, CTWA referral | 25–32 |
| 3 | LangGraph workflow: tasks, transitions, validator, interrupts, checkpointer | 40–55 |
| 4 | Follow-up policy, template authoring + approval flow, scheduling, opt-out | 18–25 |
| 5 | Monday outbox sync + appointments + Calendar | 35–45 |
| 6 | Admin panel (incl. approval/resume UI) | 25–32 |
| 7 | Simulation harness + test suite | 22–30 |
| 8 | Monitoring, hardening, deployment | 15–22 |
| | **Total** | **200–270 h** |

Down from v3's 235–320 h. Removing campaign scheduling, the unofficial channel, and bulk import saves more than the template-management work adds.

### Monthly operating

| Item | Cost |
|---|---|
| Hetzner CPX21 (3 vCPU, 4 GB) | ~€8 |
| Postgres + Redis (same host, Docker) | €0 |
| Backups | ~€3 |
| Claude API (haiku-default, inbound volume) | **~$5–20** |
| WhatsApp — inbound + in-window replies | **$0** |
| WhatsApp — follow-up templates | **TBD — needs Israel rate card** |
| Monitoring (free tiers) | €0 |
| **Total (excl. templates)** | **~$20–40 / month** |

Materially cheaper than v3's $50–90: a smaller VPS, far lower conversation volume, and no outbound send costs. Template spend scales with lead volume and follow-up policy — at 200 leads/month with 3 templated follow-ups each, expect roughly 600 billable marketing messages, so the Israel rate card is the one number needed to close this out.

---

## 13. Build order and verification

### Build order

1. **Meta Business verification + WABA setup** — slow, and on the critical path. Start immediately.
2. **Draft follow-up templates and submit for approval** — approval latency is the other critical-path item. Validate against the banned-word list before submitting.
3. Data layer: schema, entities, dedup, opt-out table.
4. **LangGraph spike** — Functional API + `PostgresSaver` on Node 24, one trivial interrupt round-trip. De-risk before committing.
5. Cloud API channel: webhooks, signature verification, media, window tracking, referral capture.
6. Workflow: tasks, transitions, validator. Testable against `FakeChannel` with no live Meta calls.
7. Monday outbox sync.
8. Follow-up policy + opt-out enforcement.
9. Appointments + Calendar + interrupt resume.
10. Admin panel.
11. Simulation phase.
12. Live pilot.

### Simulation phase — before any real lead

Dozens of scripted Hebrew conversations against the workflow with `FakeChannel`:

- All four screening paths and every disqualification rule
- Every objection in the spec; all five FAQs
- Typos, slang, mixed Hebrew/English, voice-to-text artifacts
- Anger and frustration → escalation path
- Opt-out in varied and indirect phrasings
- Already-sold or withdrawn property
- "Call me instead" · voice notes · images · unrelated messages
- Silence at every stage; replies arriving weeks later
- Contradictory answers and mid-conversation reversals
- **Window expiry mid-conversation** → correct fallback to template
- After-hours contact → the spec's after-hours message

Assertions cover stage transitions, extracted fields, validator compliance, and that **no LLM output ever mutates stage directly**.

### LangGraph-specific tests

- **Crash-resume**: kill the process at each task boundary; confirm resume without duplicate sends or duplicate LLM billing.
- **Checkpoint recovery**: delete a thread's checkpoints, rebuild from `messages` + `conversations`, confirm the conversation continues correctly — validating §5.2's disposability claim rather than assuming it.
- **Interrupt durability**: park on appointment approval, restart, resume via `Command`, confirm the Calendar event is written exactly once.
- **Concurrency**: two inbound messages during one in-flight turn — no interleaved or lost updates.

Plus: validator property-tested against the full banned list; follow-up timing with fake clocks including Shabbat skip; Monday sync idempotency and retry under simulated outage; opt-out enforcement asserted across every send path including templates.

### Live pilot

**~50 real inbound leads, every conversation manually reviewed before scaling.** Lidor personally reviews tone against the spec. Global pause tested live before go-live.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| **Meta Business verification delay** | On the critical path — start before any code. |
| **Template rejection** | Draft early, keep to utility/marketing conventions, validate against banned words, allow revision cycles. |
| Follow-ups #2–#5 lose voice fidelity as templates | Author templates in Lidor's voice; several variants; free-form resumes on any reply. |
| LangGraph JS API churn | Pin exact versions; keep the workflow thin; spike first. |
| Checkpoint/business-state drift | §5.2 rules; recovery path tested. |
| Low inbound volume makes the bot idle | Volume is a function of ad spend — worth confirming expected lead flow with Lidor before sizing anything. |

---

## 15. Engineering practices

**Repository.** This directory is not yet a Git repository — Milestone 0 initializes it. Work proceeds on a dedicated repo with small, focused commits: one logical change each, project left in a working state, clear messages.

**Simplicity first.** Abstractions are introduced only where they create a real boundary, remove meaningful duplication, or make something testable. In practice that means five: `WhatsAppChannel`, `MondayClient`, `CalendarClient`, `LlmClient`, and the repository layer over Drizzle. Everything else is plain functions and modules. No speculative interfaces, no plugin systems, no premature generalization.

**Testing in proportion to risk.** Heaviest coverage on the things that cause silent damage:

| Area | Why it matters |
|---|---|
| Conversation transitions | Wrong stage means wrong message to a real customer |
| Duplicate webhooks | Meta retries; double-processing means double replies |
| Opt-out enforcement | A message after opt-out is a legal and trust failure |
| Retries and backoff | Silent data loss between Postgres and Monday |
| Appointment approval | Double-booking or an unapproved Calendar write |
| External-service failure | Monday/Calendar/Meta outages must degrade, not break |

**Configuration and secrets.** All config through a single validated module that fails fast at startup on missing or malformed values. `.env` is git-ignored; `.env.example` documents every variable with a description. No secrets in commits, logs, or error messages.

**Per-milestone definition of done.** Typecheck, lint, and tests pass; the diff is reviewed before the milestone is called complete; the plan is updated whenever an implementation decision materially differs from it.

**Scope discipline.** One milestone at a time, completed and reviewed before the next begins. No broad parallel work across unrelated areas.

---

## 16. Milestones

Each is independently verifiable and leaves the system working.

| # | Milestone | Deliverable | Verified by |
|---|---|---|---|
| **0** | Repo and foundations | Git init, Node 24 + TS, lint/format/test tooling, Docker Compose (Postgres + Redis), validated config module, `.env.example` | Builds, lints, tests run, containers healthy |
| **1** | Data layer | Drizzle schema for all entities, migrations, repositories, dedup, opt-out table | Constraint tests, dedup tests, migration up/down |
| **2** | Inbound channel | Webhook endpoint, Meta signature verification, **idempotent ingestion**, media handling, CTWA referral capture, window tracking | Signature rejection, **duplicate-webhook dedup**, malformed payloads, media persistence |
| **3** | Conversation workflow | LangGraph entrypoint + tasks, `decideTransition`, validator, `PostgresSaver`, `FakeChannel` | All four screening paths, every disqualification rule, banned-word validator, **LLM never mutates stage**, crash-resume |
| **4** | Outbound and opt-out | Free-form send, window-aware template fallback, **opt-out enforced on every send path** | Opt-out blocks free-form, template, and follow-up paths; window expiry fallback |
| **5** | Monday.com sync | Transactional outbox, delivery worker, idempotency, backoff | Idempotent re-delivery, retry under simulated outage, **conversation unaffected by Monday downtime** |
| **6** | Appointments | `appointment_requests`, `interrupt()` approval, slot holds, Calendar write post-approval | Approval resume, **exactly-once Calendar event**, hold expiry, rejection path |
| **7** | Follow-ups | Scheduler, template follow-ups, cancellation triggers | Timing with fake clocks, Shabbat skip, cancellation on reply/booking/opt-out |
| **8** | Admin panel | Control, visibility, metrics, approval/resume UI | Auth enforced, approval resumes a real interrupted thread |
| **9** | Simulation and hardening | Simulation harness, monitoring, alerting, deployment docs | Full Hebrew scenario suite (§13) green |

Milestones 0–3 are the critical path; 4–7 depend on 3; 8 depends on 6; 9 last.

**On completion** I'll provide a summary covering architecture, milestones delivered, commit history, test coverage, remaining risks, and deployment steps.

---

## 17. Open items

**Blocking path (b) — proactive outreach to form leads**

1. **Lead form consent wording.** Currently a Privacy Policy checkbox only. Needs a
   separate visible line naming WhatsApp and the business. Until then
   `consent_status = PRIVACY_POLICY_ONLY` and the code refuses to send.
2. **Leads already collected under the current form** — decide whether to re-consent
   them or treat them as inbound-only.
3. **Meta Business verification** for Lidor — required for Cloud API, slow, start now.
4. **First-contact template** for path (b) — draft, validate against the banned-word
   list, submit for approval.

**Blocking M5 (Monday sync)**

5. **New Monday column IDs** for the five additive schema changes in §v5.
6. **Confirm Monday's native Lead Ads integration is disabled** — otherwise duplicate
   items on every form submission.

**Non-blocking**

7. **Israel rate card** from Business Manager — closes the template cost estimate.
8. **Expected lead volume** (ad spend and historical conversion) — sizes cost and capacity.
9. **Lidor's approval before any lead scoring is enabled** — unpopulated in V1.
10. **The ~22 uploaded .webm files** — confirm contents and where they belong. The spec
    marks social proof as available but never says when to send it.
11. **`עייו בודק מחירים`** in `color_mm699p5k` appears to be a typo for `עדיין`. Worth
    fixing in Monday, but the bot matches on label ID, so it is cosmetic.
