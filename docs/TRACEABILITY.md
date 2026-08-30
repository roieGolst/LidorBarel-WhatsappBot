# Requirements → Code → Tests

> Every core requirement, the module that implements it, and the test that proves
> it. **An empty Implementation or Test cell is a visible gap, not an oversight.**
> Fill the row in the same pull request that closes the gap.

Requirement IDs refer to [PRODUCT-REQUIREMENTS.md](PRODUCT-REQUIREMENTS.md) §2
(flow steps) and §3 (non-negotiables, `NN-*`).

Last updated: 2026-08-23

---

## Flow requirements

| Req | Requirement | Implementation | Tests | Status |
|---|---|---|---|---|
| 1 | Consent captured with provenance | `db/repositories/contacts.ts` · `leads/fieldMapping.ts` (`decideConsent`, field- and form-level) | `contacts.test.ts` · `fieldMapping.test.ts` · `ingestLead.test.ts` | ✅ |
| 2b | Form gating: only seller forms engage | `leads/ingestLead.ts` · `META_LEAD_SELLER_FORMS` | `ingestLead.test.ts` (form gating) | ✅ |
| 4b | Q1/Q3 seeded from the form | `leads/fieldMapping.ts` (`mapScreeningAnswers`) | `fieldMapping.test.ts` · `ingestLead.test.ts` | ✅ |
| 2a | `leadgen` webhook received and parsed | `leads/leadgenPayload.ts` · `whatsapp/routes.ts` | `leadgenPayload.test.ts` · `leadgenRoutes.test.ts` | ✅ |
| 2a | Lead retrieved by `leadgen_id` | `leads/graphLeads.ts` | `graphLeads.test.ts` | ✅ |
| 2a | Referral persisted, replay-safe on `external_lead_id` | `leads/ingestLead.ts` | `ingestLead.test.ts` (redelivery) | ✅ |
| 2b | Contact created / updated, deduped by phone | `db/repositories/contacts.ts` · `domain/phone.ts` | `contacts.test.ts` · `phone.test.ts` | ✅ |
| 2c | Approved-template send | `whatsapp/channel.ts` · `whatsapp/cloudApiChannel.ts` | `cloudApiChannel.test.ts` (sendTemplate) | ✅ |
| 2c | Grace period before first contact | `outreach/firstContact.ts` (`findLeadsAwaitingFirstContact`) | `firstContact.test.ts` | ✅ |
| 2c | First contact sent at most once | `outreach/firstContact.ts` (CAS claim on stage) | `firstContact.test.ts` (concurrent sweeps) | ✅ |
| 2c | Template does not open a messaging window | `outreach/firstContact.ts` | `firstContact.test.ts` · `e2e/leadLifecycle.test.ts` | ✅ |
| 3 | Follow-up scheduling, ≤ 5 days | `outreach/followUpPolicy.ts` · `outreach/followUp.ts` | `followUpPolicy.test.ts` · `followUp.test.ts` | ✅ |
| 3 | Nudge wording stays on-voice | `outreach/followUpMessages.ts` | `followUpMessages.test.ts` (same validator as generated replies) | ✅ |
| 3 | Never sends on Shabbat / outside business hours | `outreach/followUpPolicy.ts` | `followUpPolicy.test.ts` | ✅ |
| 4a | Conversation turn, transcript, media | `workflow/conversationTurn.ts` | `conversationTurn.test.ts` | ✅ |
| 4a | Answer validation and re-asking | `workflow/validateAnswer.ts` | `validateAnswer.test.ts` | ✅ |
| 4b | Screening and stage transitions | `workflow/decide.ts` | `decide.test.ts` | ✅ |
| 4b | Intent / extraction classification | `workflow/classify.ts` | `classify.test.ts` | ✅ |
| 4b | Priority score | `workflow/decide.ts` (`leadPriorityScore`) | `decide.test.ts` | ✅ |
| 4c | Monday projection via outbox | `monday/syncLead.ts` · `outbox/outbox.ts` · `outbox/outboxWorker.ts` | `mondayProjection.test.ts` · `leadMapping.test.ts` | ✅ |
| 4c | Outbox written in the state change's transaction | `workflow/persist.ts` · `leads/ingestLead.ts` · `outreach/firstContact.ts` | `e2e/leadLifecycle.test.ts` | ✅ |
| NN-4 | A Monday outage cannot interrupt a conversation | delivery is out of the reply path | `mondayProjection.test.ts` (retry/park) | ✅ |
| 5 | Appointment offer, hold, approval, Calendar write | *(none — tables unused)* | *(none)* | ❌ |
| 6 | Stop conditions cancel follow-ups | `outreach/followUp.ts` · `db/repositories/conversations.ts` (`recordInboundActivity`) | `followUp.test.ts` (stop conditions) · `e2e/leadLifecycle.test.ts` | ✅ |
| 7 | No message after opt-out | `whatsapp/guardedSend.ts` | `guardedSend.test.ts` | ✅ |
| — | Free-form refused outside the 24h window | `whatsapp/guardedSend.ts` · `whatsapp/window.ts` | `guardedSend.test.ts` (messaging window) | ✅ |
| — | Approved template allowed outside the window | `whatsapp/guardedSend.ts` | `guardedSend.test.ts` | ✅ |

## Non-negotiable rules

| ID | Rule | Implementation | Tests | Status |
|---|---|---|---|---|
| NN-1 | No message after opt-out | `whatsapp/guardedSend.ts` · `db/repositories/optOuts.ts` | `guardedSend.test.ts` · `optOuts.test.ts` | ✅ |
| NN-2 | **Consent gates every proactive send** | Decision: `leads/fieldMapping.ts`. Enforcement: `whatsapp/guardedSend.ts` (`ConsentRequiredError`) | `fieldMapping.test.ts` · `ingestLead.test.ts` · `guardedSend.test.ts` (proactive consent suite) | ✅ |
| NN-3 | Five-day follow-up cap | `outreach/followUpPolicy.ts` (count **and** age caps) | `followUpPolicy.test.ts` · `followUp.test.ts` | ✅ |
| NN-4 | Postgres is the source of truth | `db/schema.ts` · repository layer | integration tests on real Postgres | ✅ |
| NN-5 | LLM never sets a stage | `workflow/decide.ts` owns stages; `classify.ts` returns JSON only | `decide.test.ts` · `conversationTurn.test.ts` | ✅ |
| NN-6 | No personal data in logs | `logger.ts` redaction | `config.test.ts` (partial) | 🟡 |
| NN-7 | Monday native Lead Ads integration disabled | external configuration | *(not testable in code)* | ⏸ external |

## Supporting guarantees

| Guarantee | Implementation | Tests |
|---|---|---|
| Webhook signature verified over raw bytes, constant-time | `whatsapp/signature.ts` · `server.ts` raw-body parser | `signature.test.ts` · `routes.test.ts` |
| Redelivered webhook cannot double-reply | `whatsapp/ingest.ts` + unique `provider_message_id` | `ingest.test.ts` |
| Crash mid-turn resumes without re-sending | `workflow/checkpointer.ts` | `checkpointer.test.ts` |
| Turns for one conversation never interleave | `queue/conversationQueue.ts` (job-id coalescing) | `conversationWorker.test.ts` |
| Banned words never reach the customer | `workflow/validate.ts` | `validate.test.ts` |

---

## End-to-end test

**Status: ✅ `src/e2e/leadLifecycle.test.ts`.** The check that would have caught
the misalignment this document set exists to prevent.

**Golden path** (passing): leadgen webhook → contact + referral + conversation
with Q1/Q3 seeded → approved template sent, window still closed → lead taps a
template button → window opens → qualification asks Q2 next.

**Negative paths** (passing):

| Case | Required outcome | Status |
|---|---|---|
| Lead from a form not declared as carrying consent | Captured, attributed, **never messaged** (NN-2) | ✅ |
| Lead who messages before the grace period elapses | Inbound opening kept, no template | ✅ |
| Opted-out contact, any send | **Refused** (NN-1) | ✅ `guardedSend.test.ts` |
| Same lead swept twice / two instances | Sent **once** | ✅ `firstContact.test.ts` |

The lifecycle test also covers the nudge sequence: a silent lead is contacted,
nudged, and then replies — after which the schedule is cleared and the counter
reset.

**Not yet covered** — the steps that do not exist: Monday projection (Phase 5)
and Calendar booking (Phase 6).
