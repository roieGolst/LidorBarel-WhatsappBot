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

**The bot writes `lead_status` always, and moves groups only for the six statuses
no automation covers.**

Group membership is otherwise derived from status by the board's own automations
(`ליד חדש` → `לידים חדשים`, `ממתין לשיחה` → `לידים בטיפול`, and so on), and moving
those groups from code would race them and make the board flap.

The exception is the disqualified/opted-out set — statuses `4`, `6`, `7`, `8`,
`9`, `10` — which has no automation. For those, and only those, the bot also
moves the item to **`group_mm6qfq86` (לידים לא מתאימים)**.

This split is deliberate, not an oversight. If automations are added for those
statuses later, the bot's move becomes a harmless no-op — it targets the same
group — so the two cannot conflict.

There is one automation the bot has to accommodate rather than fight:

> `When an item is created → set סטטוס to ליד חדש, set אינטרקציה אחרונה to today`

So an item is **created first and its status set afterwards**, in a second call.
Setting status inside the create mutation races the automation, and the
automation wins about as often as it loses.

| Our stage | `lead_status` the bot writes | Group (by automation) |
|---|---|---|
| awaiting_first_contact | `2` ליד חדש | לידים חדשים |
| engaged / screening_* | `2` ליד חדש | לידים חדשים |
| qualified / handed_off | `14` ממתין לשיחה | לידים בטיפול |
| appointment_confirmed | `0` ממתין לפגישה ייעוץ | לידים בטיפול |
| disqualified | `7` exclusive · `8` uncooperative · `9` no_urgency · `10` not_selling | לידים לא מתאימים — **bot moves** |
| opted_out | `6` ביקש להפסיק | לידים לא מתאימים — **bot moves** |
| closed_no_response | `3` ליד ללא מענה | לידים ללא מענה |
| unusable phone | `5` חסר מידע | לידים בטיפול |

`1` ליד מוצלח (לקוח) is **Lidor's**, set by hand when a lead converts. The bot
must never write it.

Reaching `ממתין לשיחה` is what tells Lidor the bot is done and the lead is his to
call — before that the automations keep it in `לידים בטיפול`, so he knows not to
phone someone mid-qualification.

### ⚠️ Automation problems to resolve before go-live

These are in the board today and each one misfires once the bot starts writing.

All three are resolved (2026-08-26). Kept here because each explains why the
current arrangement is the way it is, and undoing any of them reintroduces a
specific failure.

**1. ✅ A disqualified lead would have been created as a client.**

`create an item in לקוחות` used to trigger on *movement into* `לידים סגורים`.
That was correct only while a won lead was the only thing reaching that group;
routing disqualified leads there would have created a client record for someone
who had just said they were not selling. Now triggered on
**status = `ליד מוצלח (לקוח)`**. Do not move it back to a group trigger.

**2. ✅ `אינטרקציה אחרונה` would have flooded Lidor.**

A date-arrives notification on a field the bot updates on every message. Deleted.
The daily digest (`passed in the last 7 days → notify`) expresses the same intent
without firing per message, and remains.

**3. ✅ Six statuses had no group.**

`לידים לא מתאימים` (`group_mm6qfq86`) now exists for them, keeping `סגורים` to
mean *won*. No automation drives it, so the bot performs that move itself.

### Automations the bot depends on

Worth knowing, because removing one silently changes behaviour:

| Trigger | Effect |
|---|---|
| item created | status → `ליד חדש`, `אינטרקציה אחרונה` → today |
| status → `ליד חדש` | move to `לידים חדשים` |
| status → `ממתין לשיחה` / `ממתין לפגישה ייעוץ` / `חסר מידע` | move to `לידים בטיפול` |
| status → `ליד ללא מענה` | move to `לידים ללא מענה` |
| status → `ליד מוצלח (לקוח)` | move to `לידים סגורים` |
| activity created in Emails & Activities | create a `פעילות` item and link it back |

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

- `color_mm69jtnb` label id `5` is blank and should be named or removed.
- Whether the Calendar sync covers every calendar Lidor keeps — **answered
  2026-08-26: it covers everything relevant**, so availability may be read from
  the `פעילות` board.

## `ציון רצינות` — the call order

Approved by Lidor on 2026-08-26 and now populated. This column is the product's
actual output: the bot exists to tell him **who is worth calling first**.

| Factor | Max | Values |
|---|---|---|
| Timeline | 40 | immediate 40 · within month 30 · still checking 15 · no urgency 5 |
| Readiness to list | 30 | מוכן 30 · לא בטוח 12 · לא מעוניין 0 |
| Booking intent | 15 | asked for a meeting |
| Engagement | 15 | finished screening 8 · sent photos 4 · reads as serious 3 |

Asking for a meeting also counts as immediate urgency when no timeline is known,
so "book me in" before Q3 cannot score below someone who just said they have no
urgency.

A lead with nothing known scores `null`, not zero — unscored should look
unscored, not rejected.

Judge any change to these weights by whether it improves the **order** Lidor
works his queue in. The previous version scored on timeline alone and produced
five possible values, so forty leads tied eight ways at every level.
