# AGENTS.md

This repository's agent instructions live in **[CLAUDE.md](CLAUDE.md)**. Read that
file first.

Before analysing or changing this project, you must also read, in order:

1. **[docs/PRODUCT-REQUIREMENTS.md](docs/PRODUCT-REQUIREMENTS.md)** — the single
   source of truth for what this product does.
2. **[docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md)** — what is
   built today vs. planned, and known defects.
3. **[docs/TRACEABILITY.md](docs/TRACEABILITY.md)** — requirement → module → test.

## The one thing to get right

This bot's **primary purpose is proactive, business-initiated WhatsApp outreach to
people who submitted Lidor's paid Meta lead form and consented to WhatsApp
contact.** It is not an inbound-only bot. Older documentation said otherwise and
was wrong.

*Cold outbound* to a purchased list is out of scope. *Opt-in outreach to consenting
paid leads* is the core product. Do not conflate them.

## Verify before asserting

A docstring, comment, or plan entry is not evidence that a behaviour exists. Check
for a production caller and a test before claiming something works. This repo
contains guards that are implemented, tested, and never invoked — see defects
**D-1** and **D-2** in
[docs/IMPLEMENTATION-STATUS.md](docs/IMPLEMENTATION-STATUS.md).
