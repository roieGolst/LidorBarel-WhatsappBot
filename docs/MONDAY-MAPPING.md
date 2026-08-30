# Monday.com — verified mapping

> **Read this, not the mapping table in [plan-v5.md](plan-v5.md).** That table was
> written from an earlier snapshot and at least one id in it is now wrong. Every
> id below was read from the live account on **2026-08-26** via the API.
>
> Monday is a **projection** of PostgreSQL (rule NN-4). Nothing here is a source
> of truth; the board can be rebuilt from Postgres at any time.

## Boards

| Board | ID | Bot writes? |
|---|---|---|
| לידים | `1879864606` | ✅ create + update |
| פעילות | `1879864604` | ✅ create (appointments) |
| לקוחות | `1879864610` | ❌ never — Lidor's client base (609 items) |
| נכסים | `1880668605` | ❌ never |
| עסקאות | `1879864608` | ❌ never |

## לידים — columns

| Column ID | Type | Title | Bot writes |
|---|---|---|---|
| `name` | name | Name | contact name |
| `lead_phone` | phone | Phone | E.164 |
| `email_mm6aack2` | email | דוא"ל | from the form |
| `lead_status` | status | סטטוס | lifecycle + outcome — see below |
| `color_mm69jtnb` | status | מקור הליד | `0` ממומן (form) · `6` וואטסאפ בוט (direct) |
| `text_mm0p1791` | text | טופס | Meta form **name**, form leads only |
| `text_mm6qyrr0` | text | מקור מפורט | free-text "where did you hear", direct leads only |
| `numeric_mm6q8wt4` | numbers | ציון רצינות | 0–100 priority score |
| `color_mm692wg7` | status | מוכנות מכירה | Q1 |
| `dropdown_mm6qv7ph` | dropdown | שכונה | Q2 — **new id**, see note |
| `color_mm699p5k` | status | מועד מכירה רצוי | Q3 |
| `color_mm6aapxr` | status | משווק כרגע | Q4 |
| `long_text_mm6a2mry` | long_text | פרטי נכס | free-text property notes |
| `date__1` | date | אינטרקציה אחרונה | last inbound or outbound |
| `color_mkp8eq7j` | status | מין | ❌ **not synced** — needed for Hebrew grammar, never filtered on |
| `date_mm6apc14` | date | נוצר בתאריך | ❌ **not synced** — Monday stores creation time natively |
| `multiple_person_mkpbact1` | people | בטיפול ע״ | ❌ Lidor's assignment |

### Label ids

Match by **id, never by label text** — a rename is safe, an id change is not.

**`color_mm692wg7` — מוכנות מכירה (Q1)** · `1` ready · `0` not_sure · `2` not_selling
**`color_mm699p5k` — מועד מכירה רצוי (Q3)** · `2` immediate · `0` within_month · `1` still_checking · `3` no_urgency
**`color_mm6aapxr` — משווק כרגע (Q4)** · `1` no · `0` privately · `2` with_agent
**`color_mm69jtnb` — מקור הליד** · `0` ממומן · `6` וואטסאפ בוט *(id `5` is a blank label — do not use)*

**`dropdown_mm6qv7ph` — שכונה.** Rebuilt 2026-08-26 so its 30 label ids are the
index of `BEER_SHEVA_NEIGHBORHOODS` in `src/domain/neighborhoods.ts`, **+1**. That
makes the mapping positional rather than a string match, and it must stay that
way: appending to the domain list is safe, reordering it silently corrupts every
neighbourhood on the board.

The previous column (`dropdown_mm6ah57b`, 10 labels, `א` where the domain says
`שכונה א׳`) was deleted. It held no values.

### `lead_status` and groups

The bot writes **both together**. Two columns encoding one state is how they
drift, so there must be no Monday automation moving groups — it would race the
bot's writes.

| Our stage | Group | `lead_status` |
|---|---|---|
| awaiting_first_contact | לידים חדשים | `2` ליד חדש |
| engaged / screening_* | לידים בטיפול | `2` ליד חדש |
| qualified / handed_off | לידים בטיפול | `14` ממתין לשיחה |
| appointment_confirmed | לידים בטיפול | `0` ממתין לפגישה ייעוץ |
| disqualified | לידים סגורים | `7` exclusive · `8` uncooperative · `9` no_urgency · `10` not_selling |
| opted_out | לידים סגורים | `6` ביקש להפסיק |
| closed_no_response | לידים ללא מענה | `3` ליד ללא מענה |
| unusable phone | לידים סגורים | `5` חסר מידע |

`1` ליד מוצלח (לקוח) is **Lidor's**, set by hand when a lead converts. The bot
must never write it.

Moving to `לידים בטיפול` on the lead's first reply is what tells Lidor the bot is
mid-conversation — calling someone at that moment wastes the qualification.

## פעילות — appointments

No schema changes needed.

| Column ID | Type | Title | Bot writes |
|---|---|---|---|
| `color_mkpc9t27` | status | סוג פעילות | `0` פגישת ייעוץ |
| `activity_start_time` | date | זמן התחלה | slot start |
| `activity_end_time` | date | זמן סיום | slot end |
| `board_relation_mkpcs6ky` | board_relation | איש קשר | → the לידים item |
| `activity_status` | status | סטטוס | `3` Open |
| `integration_mkpcssjf` | integration | Google Calendar event | ❌ written by Monday |
| `location_mkpchxzd` | location | מיקום | — |
| `activity_owner` | people | Owner | — |

### The Calendar integration changes Phase 6

`פעילות` is **bidirectionally synced** with Lidor's Google Calendar: Monday
writes and updates events, and events created in Calendar appear here. Verified —
all 8 existing items carry a live `google.com/calendar/event` URL.

Two consequences:

- **Booking needs no Google credentials.** Creating a `פעילות` item makes Monday
  create the Calendar event. External item **E-8 is dropped**.
- **Free/busy is a board read.** The board mirrors his calendar, so availability
  can be computed from `activity_start_time` / `activity_end_time` without
  touching the Google API.

⚠️ **Unverified:** whether the sync covers *every* calendar Lidor keeps. If he has
a second calendar that does not sync, reading availability from this board will
double-book him. Confirm before offering slots.

## Open

- **Scoring weights need Lidor's approval** before `ציון רצינות` is populated —
  plan v5 §17 item 9. The current function is one-dimensional (timeline only,
  five possible values) and is not a usable prioritisation layer.
- `color_mm69jtnb` label id `5` is blank and should be named or removed.
