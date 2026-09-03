# The `week-state` contract, as measured

**This app does not own this contract.** It is written into a weekly artifact by the
`weekly-training-plan` skill, run from a Claude Code session against the
[`hermes-training-wiki`](https://github.com/calvindotsg/hermes-training-wiki) store, and it can
change without warning or notice.

⚠️ **Corrected 2026-09-02.** This read *"the My Running Advisor Claude project"* — a Cowork project
that the wiki's `AGENTS.md` records as **being deprecated in favour of that store**. Naming a
retiring writer sends anyone chasing a contract change to a document nobody maintains. **The writer
changed; the fact that this app does not own the contract did not**, and that is the sentence the
file exists to carry. Everything below is a
measurement of three real artifacts, last taken 2026-09-01, not a specification anybody agreed to. The
consequence is baked into `src/reduce.js`: a shape it does not recognise is **refused**, loudly,
rather than published half-understood.

Measured from:

| | shape | week |
|---|---|---|
| **A** | the live **plan** page | 24–30 Aug 2026 |
| **B** | a **closeout** page | 17–23 Aug 2026 |
| **C** | a **plan** page, measured 2026-09-01 | 31 Aug – 6 Sep 2026 |
| **D** | **the same page as C**, re-measured 2026-09-03 after two mid-week reconciles | 31 Aug – 6 Sep 2026 |

🔴 **D is the first measurement of the same document twice, and it is the one that shows the table
is not stable within a single week.** C and D are the same artifact URL: 20 sessions became 24, and
the fields moved in both directions — `numbers` 9/20 → 11/24, `until` 2/20 → 4/24, and `leaveBy`
**4/20 → 1/24**. Reconciling a week does not merely flip statuses; it rewrites sessions, and a field
that was there on Monday can be gone by Thursday. **Read every row below as a sample, never as a
floor.**

The artifacts are private pages on the account that publishes them, so they are identified here by
shape rather than by id. Nothing below depends on being able to open them — the table is
the measurement.

## The finding that matters most

**A, B and C are three different document types, not three instances of one.** The plan's step 2
called them "current week" and "previous week"; they do not share a top-level shape.

| top-level key | A (plan) | B (closeout) | C (plan) |
|---|---|---|---|
| `meta` `days` | ✅ | ✅ | ✅ |
| `prose` | ✅ | ✅ | — |
| `intent`, `actions` | ✅ | — | — |
| `verdict`, `changed` | — | ✅ | — |

So **three artifacts is a sample of three shapes, not of three weeks.** Only `meta` and `days`
survive all three — the earlier version of this file said `prose` did too, and **C dropped it**,
which is the measurement rather than a prediction.

🔴 **C strengthened the thesis rather than settling it.** It arrived with two session fields
nobody had seen (`sport`, `note`), a day-level `tag` where A and B had `tags`, a new day-level
`bed` object, and **none** of `spec` `why` `means` `actual` `planKm` `photo` `watch`. A fourth
artifact is more likely to move this table again than to confirm it.

## `meta`

Present in both: `weekLabel` `weekStart` `weekEnd` `buildWeek` `ceilingKm` `kiprunDate` `bydDate`.

Only in **A**: `plannedKm` `priorWeekKm` `lastUpdated` `artifactUrl` `handoffDoc`.
Only in **B**: `prevKm` `prevLabel` `runDays` `stepPct`.

⚠️ **`plannedKm` is not universal** even though this plan's step 3 names it, and **`lastUpdated`
— the obvious source-freshness field — exists only on the plan page.** That is why this app
stamps its own `generatedAt` at publish time rather than trusting the artifact to date itself.

`weekStart`/`weekEnd` are `YYYY-MM-DD` in both and are the only fields that can answer *"does
this plan cover today?"*. They are required by `reduce.js` for exactly that reason.

⚠️ **Two allowlisted meta fields are published and rendered NOWHERE — `bydDate` and `lastUpdated`.**
Audited 2026-09-03 by matching `META_FIELDS` against every read in `view.js`, `app.html` and
`notify.js`. `kiprunDate` looks the same at a glance and is **not** in this category: `view.js` turns
it into `daysToKiprun` and the week screen prints the countdown. `lastUpdated` is superseded by
`generatedAt`, which `publish.mjs` stamps at publish time — see the note above on why the app dates
itself. They are two short strings and are left on the allowlist deliberately, because the list
gates what *may* cross rather than what must; but **a session filling `bydDate` and expecting to see
it is filling nothing**, which is the "published but unread" trap `CLAUDE.md` names.

## `days[]`

Always 7 entries in all three. Present in all: `date` (`YYYY-MM-DD`), `dow`, `sessions`.
`photo` is optional (3 of 7 in A and B, absent from C).

⚠️ **`day.state` is present on all 7 days of A and on none of B or C.** A renderer keyed on it is
wrong on the first closeout. `day.key` is likewise A-only. This app reads neither.

🔴 **`tags` in A and B became `tag` in C, and the type changed with the name.** A/B carried
`tags: {t, c}[]`; C carries `tag: string` — one word for the day's character ("Banked", "Quality",
"Long run"). The app publishes **`tag`** and renders it; a renderer that had been reading `tags`
would have gone silently empty rather than failing.

**`bed` is new in C**, present on all 7 days: `{plan, kind, text}` — a planned bedtime as `HH:MM`,
the kind of night (`Gate` `Floor` `Baseline` `Optional` seen), and the reasoning. All three are
published, through a **nested allowlist** (`BED_FIELDS`), because `pick` does not recurse and
naming `bed` alone would publish every key the artifact ever adds to it.

## `days[].sessions[]`

**Three fields are always present. Everything else is optional.**

| field | A | B | C | D | where it lands |
|---|---|---|---|---|---|
| `kind` | 20/20 | 17/17 | 20/20 | 24/24 | both screens |
| `title` | 20/20 | 17/17 | 20/20 | 24/24 | both screens |
| `status` | 20/20 | 17/17 | 20/20 | 24/24 | both screens |
| `at` | 14/20 | 15/17 | 18/20 | 23/24 | both screens |
| `until` | 14/20 | 15/17 | **2/20** | **4/24** | both screens |
| `place` | 14/20 | 15/17 | 7/20 | 9/24 | both screens |
| `leaveBy` | **13/20** | **0/17** | **4/20** | **1/24** | the big number |
| `travel` | 13/20 | 0/17 | 4/20 | 1/24 | both screens |
| `intention` | 17/20 | 14/17 | 11/20 | 14/24 | both screens |
| `oneRule` | 17/20 | 5/17 | 9/20 | 10/24 | both screens |
| `numbers` | 17/20 | 12/17 | 9/20 | 11/24 | both screens |
| `bring` | **5/20** | **0/17** | 2/20 | 3/24 | both screens |
| `sport` | — | — | 7/20 | 8/24 | both screens |
| `note` | — | — | 6/20 | 6/24 | **not published** |

⚠️ **"Where it lands" changed on 2026-09-03 and is the reason this column exists.** The Today screen
used to render a subset; it now draws today with everything the week screen draws it with, by
calling the same row and bed renderers. So **every optional field above is now read at 6am**, not
only on a screen opened deliberately — and a field left out is a gap on the primary screen rather
than on the secondary one.
| `actual` | 10/20 | 12/17 | — |
| `spec` | 20/20 | 4/17 | — |
| `why` | 20/20 | 9/17 | — |
| `means` | 17/20 | 0/17 | — |
| `miss` | 7/20 | 0/17 | — |
| `planKm` | 4/20 | 5/17 | — |
| `photo` | 4/20 | 3/17 | — |
| `watch` | 2/20 | 2/17 | — |
| `link` | 2/20 | 0/17 | — |
| `machines` | 1/20 | 0/17 | — |

🔴 **`leaveBy` — the field this whole app is built around — reads 13/20, 0/17, 4/20 and 1/24 across
the four.** The app falls back to `at`, and to no clock at all when there is neither. A design that
assumes it is wrong on the first rest day. Four independent measurements now say so.

🔴 **D localises WHY, and it is not that the departure time is unknown.** The one `leaveBy` in the
live week is on Sunday's ride. Friday has a 06:15 class in Yishun and a 09:15 booked test in
Woodlands, and the artifact's own prose computes the trip in a table — *"leave 07:45, arrive 08:42
at the routing's best"* — while that session's `oneRule` reads **"Out of the door by 07:45."**
The arithmetic exists, it is correct, and it is **trapped in prose and in a rule string**, which is
exactly the failure `references/week-state.md` warns about in the skill that writes these. It is not
a contract problem and `reduce.js` cannot fix it: a `leaveBy` nobody emitted is indistinguishable
from one that is genuinely unknowable.

⚠️ **`until` moved the most: 14/20, 15/17, then 2/20.** It is what decides how long a started
session holds the Now slot, which is why `IN_PROGRESS_GRACE_MINUTES` exists as a fallback rather
than as a nicety.

**`sport`** (`run` | `ride`) picks the mark the week screen draws beside a session. It is
published, and an **unrecognised value is dropped rather than refused** — the calvin.sg mark set is
closed, so an unknown sport is a missing icon, not a broken week.

⚠️ **`kind` is not a time.** It reads `"Gym · 06:15"` on an appointment and
`"Kit · what you are actually carrying"`, `"Rest · by design"`, `"Evening · free"` on a note.
Do not parse a clock out of it — `at` is the only time field.

⚠️ **A session with no `at` is a note attached to a day, not an appointment.** Six of A's twenty
are: kit lists, fuel plans, a wet-weather plan B. They are real content and must not be dropped;
this app sorts them after the timed sessions on their day.

### `status`

Four values seen: `planned`, `done`, `missed`, `skipped_by_design` (B, a closeout, is all `done`).
Only `planned` is treated as actionable — a session already done or deliberately skipped is not
something to leave the house for.

### Field types

- `bring` — `string[]`
- `numbers` — `{v, l}[]` (value, label)
- `tag` — `string` (C). `tags` in A and B was `{t, c}[]` where `c` ∈ `good` `grey` `cap` `heat` `""`
  — **that form was never published**
- `bed` — `{plan, kind, text}`, all strings (C)
- `spec` — `string[][]` — **not published**; the artifact's own renderer treats parts of it as raw
  HTML, and nothing raw crosses into this app
- 🔴 `note` — `string` — **not published, and the reason generalises.** It belongs to the same
  raw-HTML class as `spec`: **2 of C's 6 notes contain literal `<b>` tags.** This app renders every
  field with `textContent`, so those would arrive on screen as visible angle brackets — a defect a
  reader sees and a test suite does not. It is also where the *corrections* live ("what was
  actually announced was 7:00/km", "recorded as declined, not unavailable"), and the app shows the
  plan's latest state rather than the history of how it got there. Two independent reasons, one
  omission.

  **This is now enforced rather than remembered:** `scripts/publish.mjs` refuses any published
  string containing a tag or an HTML entity, naming the field. That gate covers `bed.text` and
  `tag` in future weeks too, without anyone having to notice first.

⚠️ **`numbers` and `bring` are published as whole structures**, with no per-element filtering — an
unrecognised key inside a `numbers` entry rides along. That predates the day-level allowlist and is
recorded here as a known gap rather than silently left: `bed` is filtered field-by-field, these two
are not.

## Times and timezone

`at`, `until` and `leaveBy` are **naive local ISO** — `"2026-08-28T18:30"`, no offset, no seconds.
They are Singapore time. Singapore has had a fixed **+08:00** since 1982 and no DST, so
`src/view.js` reads them at a fixed offset: exact here, not an approximation.

## There is now a SECOND consumer, and it is on another machine

Since 2026-09-02 a successful `--put` also sends a Telegram message from the Hermes box, built
from a summary envelope in `src/notify.js`. It reads five things and nothing else: `meta.weekLabel`,
`meta.weekStart`, `meta.weekEnd`, the day and session counts, and the next **timed, `planned`**
session's `title` / `at` / `leaveBy` / `place`.

⚠️ **So renaming one of those is a two-machine change, not a two-file one.** The far end is
`~/bin/hermes-week-notify` on the box, gated by `~/bin/test-hermes-week-notify.py`; it validates
the envelope's shape and refuses rather than sending something half-understood, which is the same
posture `reduce.js` takes one step upstream.

The envelope carries a summary rather than the week because the box **cannot fetch
`today.calvin.sg`** — `calvin.sg` is deliberately absent from that box's egress allowlist. Nothing
over there can fill in a field it was not sent.

## What this app publishes, and why the rest is dropped

`src/reduce.js` holds four allowlists — `SESSION_FIELDS`, `DAY_FIELDS`, `BED_FIELDS` and
`META_FIELDS`. `BED_FIELDS` exists because `pick` does not recurse: naming `bed` in `DAY_FIELDS`
alone would copy the whole object, unknown keys included. They are allowlists,
not deny-lists, so a **new** field appearing upstream cannot start being published by accident.
Everything not on them stays in the artifact, including every field the artifact's own renderer
treats as raw HTML.
