# Product Requirements — Lidor Barel WhatsApp Bot

> **This document is the single source of truth for what this product does.**
> Where any other file in this repository — including `CLAUDE.md`, `README.md`,
> code comments, or the implementation plan — conflicts with this document, **this
> document wins**. Change this file first, then change the code.

Last reviewed: 2026-08-23

---

## 1. What this product is

An **AI-powered WhatsApp bot that proactively contacts people who submitted Lidor
Barel's paid Meta campaign lead form and consented to be contacted on WhatsApp**,
qualifies them against the Champions Chatbot Builder spec, projects them into
Monday.com, and books consultation calls into Google Calendar.

**Proactive, business-initiated outreach to consenting paid leads is the primary
purpose of this system. It is not a future feature and not an optional flow.**

### The distinction that matters

Two different things are easy to confuse. Only one of them is out of scope.

| | In scope? |
|---|---|
| **Opt-in business-initiated outreach** — contacting a person who submitted the lead form and explicitly consented to WhatsApp contact | ✅ **YES — this is the core product** |
| **Cold outbound** — unsolicited messaging to a purchased/scraped list (the historical 48,000-record dataset) | ❌ No. Removed permanently in plan v4. |

Earlier revisions of the repo documentation collapsed these into a single banned
category of "outbound" and described the bot as "inbound-only". **That framing was
wrong and has been corrected.** See [plan-v5.md](plan-v5.md) §"v5 change".

---

## 2. The required end-to-end flow

1. A potential client submits their details through a **Meta paid-campaign lead
   form** and explicitly consents to being contacted via WhatsApp.
2. The system receives the lead through an appropriate trigger, **creates or
   updates the contact and lead records**, and **initiates contact through
   WhatsApp**.
3. If the client does not respond, or stops responding before completing
   qualification, the system sends **follow-up messages for up to five days**, to
   encourage them to complete qualification.
4. As soon as the client responds, the bot **continues the conversation, collects
   the required information, evaluates the lead's quality and readiness**, and
   **synchronizes the relevant information and qualification score with Monday
   CRM**.
5. When appropriate, the bot may **schedule a consultation call with Lidor**
   through his calendar.
6. The follow-up sequence **stops immediately** when any of the following occurs:
   - the client completes the qualification process;
   - the client requests no further messages, or opts out;
   - the lead is invalid, unreachable, or lacks minimum contact details;
   - any legal, platform-policy, or business rule requires communication to stop.
7. The system **must never** continue sending automated follow-ups after an
   opt-out.

### Flow diagram

```
Meta Instant Form  ──▶  leadgen webhook  ──▶  retrieve lead by leadgen_id
       (+ WhatsApp consent)                            │
                                                       ▼
                                        create/update contact + lead records
                                                       │
                                          ┌── consent gate (MUST) ──┐
                                          │                          │
                                  not consented                consented
                                          │                          │
                                    no send, ever          approved template send
                                                                     │
                                                       ┌─────────────┴─────────────┐
                                                  no reply                      replies
                                                       │                           │
                                          follow-ups (≤ 5 days)      ──▶  qualification flow
                                                       │                           │
                                          stop conditions (§4)          Monday sync · Calendar
```

---

## 3. Non-negotiable rules

These are **MUST** requirements. A change that weakens any of them requires an
explicit decision recorded in this file.

- **NN-1 — No message after opt-out.** No automated message of any kind may be
  sent to a contact who has opted out. Enforced at a single choke point, not by
  convention. Irreversible without an explicit, recorded re-opt-in.
- **NN-2 — Consent gates every proactive send.** A business-initiated message may
  only be sent to a contact whose consent status is `whatsapp_opt_in`. A
  privacy-policy-only checkbox is **not** sufficient. This must be **enforced in
  code**, verified by a test that fails if the guard is removed.
- **NN-3 — Five-day follow-up cap.** Automated follow-ups stop at five days, and
  immediately on any stop condition in §2.6.
- **NN-4 — PostgreSQL is the source of truth.** Monday.com is a projection and can
  be rebuilt from Postgres at any time. The reverse is never relied on.
- **NN-5 — The LLM never sets a conversation stage.** Stages are owned exclusively
  by application code, so a hallucinated transition is structurally impossible.
- **NN-6 — Personal data stays out of logs.** Transcripts and phone numbers are
  never logged.
- **NN-7 — Monday's native Lead Ads integration stays disabled.** Otherwise every
  form submission creates duplicate items.

### Legal context

Israeli **Amendment 40** (commercial-messaging consent) and **Meta's opt-in
policy** both apply to every proactive send. Amendment 40 exposure is up to
₪1,000 per message plus class-action risk. NN-1 and NN-2 are the controls that
manage this; they are compliance requirements, not preferences.

---

## 4. Explicit stop conditions

Every one of these must cancel all pending follow-ups:

| Condition | Detected by |
|---|---|
| Qualification completed | conversation reaches a terminal qualified stage |
| Opt-out requested | keyword fast-path **and** classifier intent |
| Disqualified | qualification rules |
| Invalid / unreachable / missing contact details | phone normalization failure, repeated delivery failure |
| Appointment booked | appointment confirmed |
| Legal / platform / business rule | manual DNC, global pause |

---

## 5. Out of scope

- Cold outbound to non-consenting contacts, and the 48,000-record dataset.
- Unofficial WhatsApp clients (Baileys and similar). Official Cloud API only.
- Bulk import, campaign scheduling, warm-up/pacing machinery.
- Redesigning Lidor's Monday board. The bot integrates with it as it is.

---

## 6. Related documents

| Document | Purpose |
|---|---|
| [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) | What is actually built today vs. planned |
| [TRACEABILITY.md](TRACEABILITY.md) | Requirement → module → test mapping |
| [plan-v5.md](plan-v5.md) | Full technical implementation plan |
| Champions Chatbot Builder spec | Authoritative bot **behaviour**: voice, questions, disqualification rules, objection handling |
