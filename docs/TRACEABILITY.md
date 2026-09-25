# Requirements → Code → Tests

> Every core requirement, the module that implements it, and the test that proves
> it. **An empty Implementation or Test cell is a visible gap, not an oversight.**
> Fill the row in the same pull request that closes the gap.

Requirement IDs refer to [PRODUCT-REQUIREMENTS.md](PRODUCT-REQUIREMENTS.md) §2
(flow steps) and §3 (non-negotiables, `NN-*`).

Last updated: 2026-09-08

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
| 4a | A burst of messages is answered once, nothing dropped | `queue/conversationQueue.ts` (debounce) · `workflow/conversationTurn.ts` (`loadContext` batches unanswered) | `conversationQueue.test.ts` (real Redis) · `changedAnswers.test.ts` | ✅ |
| 4a | Answer validation and re-asking | `workflow/validateAnswer.ts` | `validateAnswer.test.ts` | ✅ |
| 4a | A bare yes, a repeated re-ask, an address the classifier cannot place — none dead-ends the flow | `workflow/interactive.ts` (`screeningAnswerFor`, `MARKETED_YES_QUESTION`, `retryQuestion`) · `workflow/conversationTurn.ts` | `interactive.test.ts` · `changedAnswers.test.ts` | ✅ |
| 4a | An address given as the neighbourhood is checked once, never stored on faith | `workflow/conversationTurn.ts` · `workflow/validateAnswer.ts` | `neighborhoodClarification.test.ts` | ✅ |
| 4c | An unlisted place still reaches Lidor (notes, not a bogus label) | `monday/leadMapping.ts` | `leadMapping.test.ts` | ✅ |
| 4b | Screening and stage transitions | `workflow/decide.ts` | `decide.test.ts` | ✅ |
| 4b | Intent / extraction classification | `workflow/classify.ts` | `classify.test.ts` | ✅ |
| 4b | Priority score | `workflow/decide.ts` (`leadPriorityScore`) | `decide.test.ts` | ✅ |
| 4c | Monday projection via outbox | `monday/syncLead.ts` · `outbox/outbox.ts` · `outbox/outboxWorker.ts` | `mondayProjection.test.ts` · `leadMapping.test.ts` | ✅ |
| 4c | Outbox written in the state change's transaction | `workflow/persist.ts` · `leads/ingestLead.ts` · `outreach/firstContact.ts` | `e2e/leadLifecycle.test.ts` | ✅ |
| NN-4 | A Monday outage cannot interrupt a conversation | delivery is out of the reply path | `mondayProjection.test.ts` (retry/park) | ✅ |
| 5 | Offer real free times | `appointments/availability.ts` · `appointments/booking.ts` | `availability.test.ts` · `booking.test.ts` | ✅ |
| 5 | Book into Lidor's calendar | `appointments/booking.ts` (`פעילות` → Monday sync) | `booking.test.ts` · `e2e/leadLifecycle.test.ts` · **verified live 2026-09-08** (IMPLEMENTATION-STATUS §Phase 6) | ✅ |
| 4c | A projection deleted by hand is recreated | `monday/syncLead.ts` · `monday/client.ts` (`itemExists` checks `state`) | `client.test.ts` · `mondayProjection.test.ts` | ✅ |
| 5 | A time chosen in words books like a tap — resolved in code first (earliest/latest, hour, ordinal, day, part of day, today/tomorrow; a yes to the time the bot just proposed), the classifier only after; two written replies without a pick are the most before the list and a plain ask | `appointments/slotMessages.ts` (`resolveSlotChoice`, `slotMentionedIn`, `acceptsProposedTime`) · `workflow/classify.ts` (`chosenOfferedTime`) · `workflow/conversationTurn.ts` (`bookChosenSlot`, `ASSIST_BOOKING_MAX`) · `workflow/generate.ts` (`assist_booking`) | `slotMessages.test.ts` · `changedAnswers.test.ts` (D-14 replays) · `classify.test.ts` · `e2e/leadLifecycle.test.ts` | ✅ |
| 5 | A booked lead is never re-screened or booked twice; asking for a meeting offers to MOVE the one they have, on the same פעילות item | `workflow/conversationTurn.ts` (`offer_reschedule`) · `appointments/booking.ts` (`bookSlot` update path) | `stageMatrix.test.ts` (every input at `appointment_confirmed`; reschedule replay) | ✅ (calendar propagation: E-14) |
| 5 | The calendar event is titled with the person's name; its description carries the note (name, phone, answers, score) and a model-written brief (property, concerns, focus point to close), on booking, move and reminder | `appointments/meetingNote.ts` · `appointments/meetingBrief.ts` · `appointments/booking.ts` · `workflow/conversationTurn.ts` (`ct_meetingBrief`) · `appointments/exclusivityCallback.ts` (`תיאור חופשי` = `text_mm7fdakx`) | `meetingNote.test.ts` · `meetingBrief.test.ts` · `booking.test.ts` · `e2e/leadLifecycle.test.ts` (brief reaches the column) · `exclusivityCallback.test.ts` | ✅ |
| 5 | Never double-book | availability re-read at booking time | `booking.test.ts` (slot taken) | ✅ |
| 5 | Never offer outside meeting hours or on Shabbat | `appointments/availability.ts` | `availability.test.ts` | ✅ |
| 4 | After screening, a bounded discovery conversation (≤ 3 questions) learns the property, the reason and what matters; shortened to ≤ 2 in *preparation* mode for a lead who asked for a meeting, cut to one for a terse lead, skipped when already said | `workflow/decide.ts` (`nextScreeningStep`, `DISCOVERY_MAX`, `DISCOVERY_MAX_BOOKING`, `isTerseAnswer`, `discoveryContext`) · `workflow/generate.ts` (`ask_intent`) | `decide.test.ts` (intent check block: thin answer, both known, cap, meeting-asked block, terse vs talkative, said unprompted, no nagging) · `conversationTurn.test.ts` (preparation mode) | ✅ |
| 5 | A lead scoring 80+ (selling now) is offered Lidor's **soonest** free times, at most three per day; everyone else the spread | `workflow/decide.ts` (`URGENT_OFFER_SCORE`, `offerStrategyFor`) · `appointments/availability.ts` (`pickEarliestSlots`) · every `findSlotsToOffer` call (turn, re-offer, nudge) | `decide.test.ts` · `availability.test.ts` · `e2e/leadLifecycle.test.ts` (list rows are the earliest) | ✅ |
| 5 | Offered times cover morning / midday / evening, on a half-hour grid from 08:30 | `appointments/availability.ts` (`pickOfferSlots`) | `availability.test.ts` · `booking.test.ts` | ✅ |
| 3 | A lead offered times who goes quiet is nudged with the times again | `outreach/followUp.ts` (`appointments`) · `outreach/followUpMessages.ts` (`APPOINTMENT_NUDGE_BODY`) | `followUp.test.ts` (list nudge, tap books, template outside the window, empty calendar) · `followUpMessages.test.ts` | ✅ |
| 5 | A high-priority lead is offered a meeting without asking | `workflow/decide.ts` (`HIGH_PRIORITY_SCORE`, `bookingSuggested`) · `appointments/slotMessages.ts` (`SLOT_SUGGEST_BODY`) | `decide.test.ts` · `changedAnswers.test.ts` | ✅ |
| 4a | A listed neighbourhood typed in any known variant answers Q2 | `workflow/interactive.ts` (`screeningAnswerFor`) · `domain/neighborhoods.ts` | `interactive.test.ts` · `neighborhoods.test.ts` · `changedAnswers.test.ts` | ✅ |
| 5 | A question while times are offered is answered with the real times, not deflected | `workflow/decide.ts` (`appointment_proposed` routing) · `workflow/generate.ts` (`assist_booking`, `[CONTEXT]`) · `appointments/slotMessages.ts` | `decide.test.ts` · `changedAnswers.test.ts` · `generate.test.ts` | ✅ |
| 5 | A meeting time tapped from a stale list is never read as a property answer | `appointments/slotMessages.ts` (`isSlotLabel`) · `workflow/conversationTurn.ts` | `slotMessages.test.ts` · `changedAnswers.test.ts` | ✅ |
| 4 | A changed answer after qualification is confirmed before it is applied | `workflow/decide.ts` (`changedScreeningFact`) · `workflow/interactive.ts` (`factChangeConfirmation`) | `decide.test.ts` · `changedAnswers.test.ts` | ✅ |
| 4 | A returning lead is not re-screened from the top | `db/repositories/conversations.ts` (`reopenedFacts`) · `workflow/decide.ts` (`intentAssessed`) | `ingest.test.ts` · `decide.test.ts` · `changedAnswers.test.ts` | ✅ |
| 4 | The closes are fixed, validated Hebrew | `workflow/interactive.ts` (`disqualificationClose`, `EXCLUSIVITY_QUESTION`) | `interactive.test.ts` · `conversationTurn.test.ts` | ✅ |
| 4 | An exclusivity end becomes a callback reminder in Lidor's calendar, once | `appointments/exclusivityCallback.ts` · `monday/syncLead.ts` · `workflow/classify.ts` (`exclusivityEndsOn`) | `exclusivityCallback.test.ts` · `mondayProjection.test.ts` · `classify.test.ts` · `localTime.test.ts` | ✅ |
| 6 | A lead who cannot be messaged is parked, not retried every sweep | `outreach/firstContact.ts` · `outreach/followUp.ts` · `whatsapp/guardedSend.ts` (`isPermanentSendFailure`) | `firstContact.test.ts` · `followUp.test.ts` · `guardedSend.test.ts` · `cloudApiChannel.test.ts` | ✅ |
| 6 | Follow-up outcomes are projected to the board | `outreach/followUp.ts` | `followUp.test.ts` | ✅ |
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
| A turn's messages arrive in the order sent, even behind a video | `whatsapp/deliveryGate.ts` · `workflow/conversationTurn.ts` (`ct_awaitDelivery`) · `whatsapp/routes.ts` | `deliveryGate.test.ts` · `conversationTurn.test.ts` · `routes.test.ts` |
| A typed restart, and a "back" after qualification, ask before discarding anything | `workflow/conversationTurn.ts` (`handleGate` → `confirm_restart`) | `stageMatrix.test.ts` · `conversationTurn.test.ts` |
| Every live stage × every deterministic input holds the four structural rules (no throw, no fact loss post-qualification, booking survives, booked lead never regressed) | `workflow/stageMatrix.test.ts` | itself — 110 cells |
| NN-8 — a deletion request erases the person everywhere the bot wrote them, keeps only the number on the do-not-contact list, works for an opted-out contact | `workflow/dataRequests.ts` · `privacy/erase.ts` · `workflow/conversationTurn.ts` (`eraseOnRequest`; thread deleted after the run) | `dataRequests.test.ts` · `erase.test.ts` · `privacyRequests.test.ts` |
| NN-9 — conversation data purged after `DATA_RETENTION_MONTHS`; the CRM untouched | `privacy/retentionSweeper.ts` · `main.ts` | `retentionSweeper.test.ts` · `erase.test.ts` (retention reason) |
| NN-10 — asking for a person ends the automated flow; a booked lead keeps their meeting | `workflow/gate.ts` (4b) · `workflow/dataRequests.ts` | `dataRequests.test.ts` · `privacyRequests.test.ts` |
| NN-6 — log redaction of body/text/phone/to | `logger.ts` | `logger.test.ts` |
| The privacy page prints the caps and periods the code enforces; `FOLLOWUP_MAX_*` clamped to five | `site/privacyPage.ts` · `config.ts` | `privacyPage.test.ts` · `config.test.ts` · `routes.test.ts` |
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

The lifecycle test now runs the full funnel: form submission → template → reply →
qualification → Monday projection → a booked consultation in Lidor's calendar.
