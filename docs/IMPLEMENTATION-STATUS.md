# Implementation Status

> **Current behaviour vs. planned behaviour.** Update this file in the same pull
> request as any change that moves an item between columns. A docstring or a plan
> entry is *not* evidence that something works — this file records what the code
> actually does today.

Last audited: **2026-08-23**. Phase 0 and Phase 1 delivered.

Legend: ✅ Fully implemented · 🟡 Partial · 📋 Planned (schema/scaffolding only) ·
❌ Missing · ⚠️ Conflicting (docs claim behaviour the code does not have)

---

## 1. Status against the required flow

Requirements are numbered per [PRODUCT-REQUIREMENTS.md](PRODUCT-REQUIREMENTS.md) §2.

| Req | Capability | Status | Notes |
|---|---|---|---|
| 1 | Lead form + WhatsApp consent | ✅ | The live seller form carries a **required** consent checkbox naming WhatsApp and the business. Recognised per-form — see §3.1. |
| 2a | Receive lead via `leadgen` webhook | ✅ | `src/leads/leadgenPayload.ts`, dispatched from the shared webhook route. |
| 2b | Create / update contact + lead records | ✅ | `src/leads/ingestLead.ts`. Contact + conversation + referral in one transaction. |
| 2c | Initiate WhatsApp contact via template | ✅ | `src/outreach/`. **Off by default** — `OUTREACH_ENABLED` must be set, and E-1 gates go-live. |
| 3 | Follow-ups for up to five days | ✅ | `src/outreach/followUp*.ts`. Two caps, business hours, Shabbat-safe. Out-of-window nudges need an approved template (E-10). |
| 4a | Continue conversation, collect information | ✅ | The mature part of the system. |
| 4b | Evaluate lead quality and readiness | ✅ | Four-factor 0–100 score, approved by Lidor and projected to `ציון רצינות`. |
| 4c | Sync to Monday CRM | ✅ | `src/monday/` + `src/outbox/`. Verified against the live board. `ציון רצינות` awaits approved weights. |
| 5 | Schedule consultation call | ❌ | No module, no dependency. |
| 6 | Follow-up stop conditions | ✅ | Reply, terminal stage, qualification complete, both caps, opt-out, consent. Each covered by a test. |
| 7 | Never message after opt-out | ✅ | Enforced at `guardedSend`, the single choke point every send passes through. |

---

## 2. What works today

The **inbound conversation engine is production-quality** and carries the large
majority of the 377-test suite.

| Area | Detail |
|---|---|
| Webhook security | Constant-time signature verification over raw bytes (`src/whatsapp/signature.ts`). Deliberate status codes: 403 bad signature, 503 no credentials, 200 unparseable-but-signed. |
| Idempotent ingestion | Unique `provider_message_id`; redelivery cannot double-reply (`src/whatsapp/ingest.ts`). |
| Conversation workflow | LangGraph durable execution, Postgres checkpoints, per-conversation `thread_id` (`src/workflow/`). |
| Screening & qualification | All screening paths, every disqualification rule, entry-point-aware question skipping (`src/workflow/decide.ts`). |
| Opt-out detection | Keyword fast-path **plus** classifier intent; LLM-independent (`src/workflow/optOutKeywords.ts`). |
| Opt-out enforcement | Single choke point that throws rather than no-ops (`src/whatsapp/guardedSend.ts`). |
| Consent merge logic | Opt-out is sticky — a later form submission cannot silently re-enable messaging (`mergeConsent`). |
| Interactive messages | Reply buttons, lists, video, typing indicator (`src/whatsapp/cloudApiChannel.ts`). |
| Cost accounting | Per-call model, tokens, and USD stored on `messages`. |

---

## 3. Known defects and conflicts

Items where the repository *claims* a behaviour it does not have. These are more
dangerous than plain gaps, because reviewers trust them.

| ID | Defect | Evidence | Risk |
|---|---|---|---|
| ~~**D-1**~~ | ~~Consent gate is inert.~~ **Fixed in Phase 2.** `guardedSend` now takes an explicit send intent and checks `canReceiveProactiveMessage` for every proactive send. The type system makes a proactive send inexpressible without a contact to check. | `src/whatsapp/guardedSend.ts` | Resolved. **NN-2 enforced and tested.** |
| ~~**D-2**~~ | ~~Send window never checked.~~ **Fixed in Phase 2.** Free-form sends are refused outside the 24-hour window; an approved template is the documented exception. | `src/whatsapp/guardedSend.ts` | Resolved. |
| ~~**D-3**~~ | ~~`leadgen` payloads are silently discarded.~~ **Fixed in Phase 1.** The route now dispatches on `envelope.object`, and an unconfigured lead path fails closed with 503 rather than ACKing. | `src/whatsapp/routes.ts` · `src/leads/` | Resolved. |
| **D-4** | **Unused scaffolding.** `outbox` table, `appointment_requests` table, all `appointment_*` stages, `messages.template_ref`, `campaign_referrals.form_id` / `.external_lead_id`, `setMondayItemId()` — all defined, none written or read by production code. | `src/db/schema.ts` | Not a bug; a reminder that schema presence ≠ implementation. |

---

## 4. Roadmap phases

Reordered from the plan's original M0–M9 so that **proactive outreach — the core
purpose — precedes the projection and booking layers**. The original ordering
(Monday → Appointments → Follow-ups) reflected the superseded inbound-first framing.

| Phase | Deliverable | Depends on | Status |
|---|---|---|---|
| **0** | Alignment documents (this set) | — | ✅ Done |
| **1** | `leadgen` intake: parse, retrieve by `leadgen_id`, persist contact + referral. **Sends nothing.** | 0 | ✅ Done |
| **2** | Wire the consent gate (**D-1**) and window enforcement (**D-2**) | 1 | ✅ Done |
| **3** | Approved-template first contact + grace period | 2, E-1 | ✅ Built (go-live waits on E-1) |
| **4** | Follow-up scheduler with all stop conditions | 3 | ✅ Done |
| **5** | Monday sync via transactional outbox | 4 | ✅ Done |
| **6** | Appointments via פעילות (Monday writes the Calendar event) | 5 | ⏭ Next — much smaller than planned |
| **7** | Admin panel, simulation, production readiness | 6 | Not started |

Phase 1 required **no migration** — `campaign_referrals.form_id` and
`.external_lead_id` already existed with a unique index.

### Meta behaviour worth knowing

**Privacy-step disclaimer checkboxes are not returned in a lead's `field_data`,
even when required.** Verified against a real lead from form `1746567036243410`:
the form's `legal_content.custom_disclaimer.checkboxes[0]` is `is_required: true`
and `is_checked_by_default: false`, yet the lead carries only the two screening
answers, name, phone, and email.

Per-lead consent detection alone would therefore refuse every lead forever. So
consent is recognised two ways, strongest first: a per-lead field when the form
asks consent as an ordinary question, otherwise a **per-form declaration**
(`META_LEAD_CONSENT_FORMS`). The per-form rule is sound because the checkbox
cannot be skipped, is not pre-checked, and **Meta forms are immutable** — a form
id permanently identifies the exact wording agreed to. An explicit per-lead
refusal always overrides the form rule, and unlisted forms stay
`privacy_policy_only`.

The Page also runs investor and recruitment campaigns, and carries several
retired seller forms. Exactly one form is live: `1746567036243410`.
`META_LEAD_SELLER_FORMS` gates which forms enter the seller flow; leads from the
rest are recorded for attribution with no conversation opened. Replacing the form
(for updated privacy wording, say) means a new id in both lists — Meta forms are
immutable, so wording changes always produce a new form.

### What Phase 5 delivers

The Monday projection, through a transactional outbox.

**The outbox event is written in the same transaction as the state change**, which
is the property that matters: a conversation cannot advance without its
projection being queued, and the conversation never waits on Monday to do it. A
Monday outage delays the board and nothing else (NN-4).

Delivery carries no payload beyond the conversation id — the worker re-reads
current state, so a delayed, repeated, or out-of-order delivery projects the
truth rather than a stale snapshot. That also makes several events for one
conversation coalesce into a single write.

Written against the **real board**, verified live: every column id, label id, and
value format was exercised against Monday before the code was trusted, including
a create/update/move/delete round trip.

Two behaviours worth knowing:

- **Status is set after creation, not during it.** A board automation sets
  `ליד חדש` on create; passing a status in the same mutation races it.
- **The bot moves one group and only one.** Automations file every status except
  the disqualified/opted-out set, which the bot files into `לידים לא מתאימים`
  itself. See [MONDAY-MAPPING.md](MONDAY-MAPPING.md).

`ציון רצינות` is populated from the four-factor score Lidor approved on
2026-08-26 (timeline 40 · readiness 30 · booking 15 · engagement 15). This is the
product's actual output — the bot exists to tell him who to call first — so
scoring changes are judged on whether they improve the call order.

### What Phase 4 delivers

The follow-up sequence, and — more to the point — every way it stops.

**Two independent caps.** The requirement says "up to five days"; the spec says
"5 messages, 1 day apart". Both are enforced and whichever is reached first ends
the sequence, because reading either loosely means messaging someone on day six.

**Anchored on the silence, not the conversation.** The cap runs from the person's
last message, or the opening if they never replied. A lead who answers on day six
and then goes quiet is entitled to the same sequence as one who never answered;
anchoring on conversation age would silently deny it. Equally, "has replied" is
never the stop test — a mid-qualification lead has replied many times. The test is
whether they answered our *latest* message.

**Stops:** a reply, a terminal stage, `qualified` or `appointment_confirmed`
(requirement §2.6's "completes the qualification process"), either cap, opt-out,
or missing consent. Reaching a cap also closes the conversation, so it leaves the
working set. Every path clears the schedule, so nothing can sit due forever.

**Business hours.** Never on Shabbat; Sun–Thu 08:00–20:00, Fri 08:00–14:00 in
`APP_TIMEZONE`. A due nudge is shifted into the next open slot — but shifting may
not push it past the five-day cap, so a message moved out of Shabbat can end the
sequence instead of extending it. Hour-by-hour stepping keeps this correct across
Israel's DST change.

**Two out-of-window templates, not one.** Which is sent depends on `lastInboundAt`: someone who never answered needs re-introducing, someone mid-qualification does not. A missing template means that nudge is skipped rather than substituted.

**Wording is written, not generated.** A background nudge with nobody watching
does not need an LLM turn, and `followUpMessages.test.ts` runs each message
through the same voice validator the model's replies face.

### What Phase 3 delivers

Business-initiated first contact — the product's primary purpose — end to end:
`sendTemplate` on the channel, and a sweeper that opens the approved
`welcome_message` template to consented leads once their grace period elapses.

**Off unless `OUTREACH_ENABLED=true`.** This is the only subsystem that messages
people who have not messaged us, so it never starts merely because credentials
are present. It also refuses to start without the conversation worker: opening a
conversation whose replies nobody answers is worse than not opening it.

Two properties worth knowing:

- **At most once.** Each send is claimed by a compare-and-swap on the
  conversation's stage (`awaiting_first_contact` → `awaiting_reply`). Only the
  caller whose UPDATE returned a row sends, so a second sweep, a second instance,
  or a redelivered job finds nothing to claim. A failed send releases the claim,
  so the lead is retried rather than silently abandoned.
- **A template does not open a window.** `windowExpiresAt` is untouched; only the
  lead's reply opens one. Until then the bot may send templates and nothing else,
  which `guardedSend` enforces.

Postgres is the schedule, not Redis: a lead awaiting contact is a row, so the
work survives a flush, a redeploy, and a crash.

The approved template's four quick-reply buttons match the bot's own menu titles
exactly, and a template button arrives as ordinary message text — so a lead
tapping one lands in the existing menu handling with no special casing. The
stored transcript records the real welcome wording rather than a placeholder, so
the model reads a faithful history when the lead replies.

### What Phase 2 delivers

`guardedSend` is now the enforcement point for three rules rather than one, and
callers state *what kind of send this is* instead of passing a bare phone number:

```ts
{ kind: 'reply',     to, conversation }            // consent not at issue
{ kind: 'proactive', to, contact, isTemplate }     // consent required
```

The discriminated union is the point: a proactive send **cannot be expressed**
without a contact to check consent against. That is what stops D-1 recurring —
the previous signature accepted a phone number, so forgetting the check was the
path of least resistance.

Rules enforced, in order: opt-out (outranks everything, template included),
consent for proactive sends, then an open messaging window unless the payload is
an approved template. A recipient/contact mismatch is also refused, so consent can
never be satisfied by checking a different person's record.

The dev-reset confirmation, previously the one send bypassing the choke point,
now goes through it too.

### What Phase 1 delivers

A lead-form submission now creates a contact (`entry_point = meta_lead_form`), a
conversation in `awaiting_first_contact`, and a `campaign_referrals` row holding
every answer verbatim. Redelivery is idempotent on `external_lead_id`. **No
message is sent** — that is Phase 3, gated on Phase 2's consent enforcement.

Consent is decided by `src/leads/fieldMapping.ts` and **fails closed**: with no
consent source configured, every lead is recorded as `privacy_policy_only`.
Enabling the `leadgen` webhook field is therefore safe — leads are captured and
none can be messaged until a form is explicitly declared.

The form's Q1 and Q3 answers are mapped onto `sellIntent` and `timeline` and
seeded on the new conversation. This is required, not an optimisation: a
`meta_lead_form` lead is screened on Q2 and Q4 only, so without the seed those
answers would be neither asked nor known.

---

## 5. External blockers (not code)

These are owned by Lidor / the operator, and several are slow. They gate Phase 3
onward, so start them early.

| # | Item | Gates |
|---|---|---|
| E-1 | Meta Business verification | Template sending |
| E-2 | ✅ Done — the seller form has a required consent checkbox | — |
| E-9 | **Consent wording scope.** The checkbox says *הודעת אישור* (a confirmation message); the bot runs a qualification conversation plus five days of follow-ups. Under Amendment 40 those are commercial messages. Worth a privacy review, and worth broadening on the next form. | Volume send |
| E-3 | Decision on leads already collected under the old form (re-consent or treat as inbound-only) | Phase 3 |
| E-4 | ✅ Done — template approved by Meta | — |
| E-5 | `leads_retrieval` permission + Page access token (`META_PAGE_ACCESS_TOKEN`) + Page subscribed to `leadgen` | Phase 1 go-live |
| E-6 | ✅ Done — Monday native Lead Ads integration disabled | — |
| ~~E-7~~ | ✅ Done — token in place, columns verified live, board automations corrected | — |
| ~~E-8~~ | ~~Google Cloud project, calendar credentials~~ **Dropped.** פעילות is bidirectionally synced with Lidor's calendar, so booking is a Monday write and availability is a Monday read. | — |
| E-10 | **Approved template: nudging a lead who never replied.** They have no messaging window, so without it non-responders cannot be nudged at all. Drafted and validated — see the Phase 4 notes. | Nudging non-responders |
| E-11 | **Approved template: nudging a lead who started and stopped.** Different wording — thanking someone mid-qualification for "leaving details" reads as though we lost track of them. Without it, those nudges only work within 24 hours of their last message. | Nudging partial completions |

---

## 6. Test coverage reality

587 tests across 39 files, colocated, with integration tests running against a
real PostgreSQL. Phase 4 added the stop-condition suite — every cap, stage, and
refusal asserted separately — plus Shabbat and business-hours cases pinned to
real Israeli local times in both DST states.
Coverage of the inbound engine is genuinely strong.

**The end-to-end test now exists**: `src/e2e/leadLifecycle.test.ts` carries a lead
from form submission through the template, the reply, and into the qualification
conversation, asserting that Q1/Q3 come from the form and Q2 is asked next. It
also covers the two refusals that matter — a non-consenting lead is captured and
never messaged, and a lead who messages first keeps the inbound opening.

This is the test that would have caught the misalignment this document set exists
to prevent: before it, the entire proactive product could have been deleted and
the suite would have stayed green.

Still uncovered end to end: Monday projection and Calendar booking, which do not
exist yet (Phases 5 and 6).
