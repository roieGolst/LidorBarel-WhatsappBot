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
| 1 | Consent captured with provenance | `db/repositories/contacts.ts` (`mergeConsent`, `consentSource`, `consentText`) | `contacts.test.ts` | ✅ |
| 2a | `leadgen` webhook received and parsed | *(none)* | *(none)* | ❌ |
| 2a | Lead retrieved by `leadgen_id` | *(none)* | *(none)* | ❌ |
| 2a | Referral persisted, replay-safe on `external_lead_id` | schema only — `db/schema.ts` `campaign_referrals` | *(none)* | 📋 |
| 2b | Contact created / updated, deduped by phone | `db/repositories/contacts.ts` · `domain/phone.ts` | `contacts.test.ts` · `phone.test.ts` | ✅ |
| 2c | Approved-template send | *(none — no `sendTemplate`)* | *(none)* | ❌ |
| 2c | Grace period before first contact | *(none)* | *(none)* | ❌ |
| 3 | Follow-up scheduling, ≤ 5 days | schema only — `conversations.next_followup_at` | *(none)* | 📋 |
| 4a | Conversation turn, transcript, media | `workflow/conversationTurn.ts` | `conversationTurn.test.ts` | ✅ |
| 4a | Answer validation and re-asking | `workflow/validateAnswer.ts` | `validateAnswer.test.ts` | ✅ |
| 4b | Screening and stage transitions | `workflow/decide.ts` | `decide.test.ts` | ✅ |
| 4b | Intent / extraction classification | `workflow/classify.ts` | `classify.test.ts` | ✅ |
| 4b | Priority score | `workflow/decide.ts` (`leadPriorityScore`) | `decide.test.ts` | ✅ |
| 4c | Monday projection via outbox | *(none — `outbox` table unused)* | *(none)* | ❌ |
| 5 | Appointment offer, hold, approval, Calendar write | *(none — tables unused)* | *(none)* | ❌ |
| 6 | Stop conditions cancel follow-ups | *(no follow-ups to cancel yet)* | *(none)* | ❌ |
| 7 | No message after opt-out | `whatsapp/guardedSend.ts` | `guardedSend.test.ts` | ✅ |

## Non-negotiable rules

| ID | Rule | Implementation | Tests | Status |
|---|---|---|---|---|
| NN-1 | No message after opt-out | `whatsapp/guardedSend.ts` · `db/repositories/optOuts.ts` | `guardedSend.test.ts` · `optOuts.test.ts` | ✅ |
| NN-2 | **Consent gates every proactive send** | `canReceiveProactiveMessage()` exists but **has no caller** — see **D-1** | `contacts.test.ts` tests the predicate, **not its enforcement** | ⚠️ |
| NN-3 | Five-day follow-up cap | *(none)* | *(none)* | ❌ |
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

## Required end-to-end test

**Status: ❌ does not exist.** This is the check that would have caught the
misalignment this document set exists to prevent.

Planned location: `src/e2e/leadLifecycle.test.ts`

**Golden path** — must pass:

1. `leadgen` webhook arrives → contact + `campaign_referrals` rows created
2. Replaying the same `leadgen_id` creates nothing further
3. Consented lead → template first contact sent
4. Lead replies → 24h window opens → qualification proceeds
5. Qualification completes → Monday projection written → follow-ups cancelled

**Negative paths** — must also pass:

| Case | Required outcome |
|---|---|
| `privacy_policy_only` contact, proactive send attempted | **Refused** (NN-2) |
| Opted-out contact, any send attempted | **Refused** (NN-1) |
| Follow-up due, contact opted out in the meantime | **Not sent, cancelled** (NN-3) |
| Follow-up window exceeds five days | **Not sent** (NN-3) |
