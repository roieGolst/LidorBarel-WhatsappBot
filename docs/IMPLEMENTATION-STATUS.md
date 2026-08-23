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
| 2c | Initiate WhatsApp contact via template | ❌ | No `sendTemplate` on the channel. |
| 3 | Follow-ups for up to five days | 📋 | `next_followup_at` / `followup_count` columns and index exist. No scheduler. |
| 4a | Continue conversation, collect information | ✅ | The mature part of the system. |
| 4b | Evaluate lead quality and readiness | ✅ | `qualified`, `disqualification_reason`, `priority_score`. |
| 4c | Sync to Monday CRM | ❌ | No module, no dependency. `outbox` table written by nothing. |
| 5 | Schedule consultation call | ❌ | No module, no dependency. |
| 6 | Follow-up stop conditions | ⚠️ | Opt-out primitives solid; **consent gate is inert** (see §3). |
| 7 | Never message after opt-out | ✅ | Enforced at `guardedSend` for all paths that currently exist. |

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
| **D-1** | **Consent gate is inert.** `canReceiveProactiveMessage()` is implemented and unit-tested but has **zero production callers**. `guardedSend` checks opt-out only, never `consent_status`. `src/db/schema.ts` claims "the send path refuses them"; plan v5 claims "enforced in code, not by policy". | `src/db/repositories/contacts.ts` · `src/whatsapp/guardedSend.ts` | Harmless today (no proactive path). **Becomes an Amendment 40 exposure the moment template send ships.** Must be wired *before* Phase 3. Violates **NN-2**. |
| **D-2** | **Send window never checked.** `sendWindow()` / `canSendFreeForm()` are implemented and tested with **zero production callers**. Nothing falls back to a template when the 24h window is closed. | `src/whatsapp/window.ts` | Masked today (all sends are replies inside an open window). A send outside the window will be rejected by Meta. |
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
| **2** | Wire the consent gate (**D-1**) and window enforcement (**D-2**) | 1 | ⏭ Next |
| **3** | Approved-template first contact + grace period | 2, Meta approvals | Not started |
| **4** | Follow-up scheduler with all stop conditions | 3 | Not started |
| **5** | Monday sync via transactional outbox | 4 | Not started |
| **6** | Appointments + Google Calendar | 5 | Not started |
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

The Page also runs investor and recruitment campaigns. `META_LEAD_SELLER_FORMS`
gates which forms enter the seller flow; leads from the rest are recorded for
attribution with no conversation opened.

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
| E-7 | Monday API token + the five additive column IDs | Phase 5 |
| E-8 | Google Cloud project, calendar credentials and sharing | Phase 6 |

---

## 6. Test coverage reality

479 tests across 33 files, colocated, with integration tests running against a
real PostgreSQL. Phase 1 added 102, including the consent fail-closed cases, the
form-gating rules, and the webhook's retry-classification behaviour.
Coverage of the inbound engine is genuinely strong.

**Remaining gap:** there is still **no single test spanning the whole flow**
end to end. Phase 1 covers lead intake, and the inbound engine is covered, but
nothing yet joins form submission → template → reply → qualification → sync,
because the middle of that chain does not exist. See
[TRACEABILITY.md](TRACEABILITY.md) for the planned test.
