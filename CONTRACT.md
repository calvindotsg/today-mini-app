# The `week-state` contract, as measured

**This app does not own this contract.** It is written by the *My Running Advisor* Claude project
into a weekly artifact, and it can change without warning or notice. Everything below is a
measurement of three real artifacts, last taken 2026-09-01, not a specification anybody agreed to. The
consequence is baked into `src/reduce.js`: a shape it does not recognise is **refused**, loudly,
rather than published half-understood.

Measured from:

| | shape | week |
|---|---|---|
| **A** | the live **plan** page | 24–30 Aug 2026 |
| **B** | a **closeout** page | 17–23 Aug 2026 |
| **C** | a **plan** page, measured 2026-09-01 | 31 Aug – 6 Sep 2026 |

The two artifacts are private pages in the Claude project that writes them, so they are identified
here by shape rather than by id. Nothing below depends on being able to open them — the table is
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

| field | A | B | C |
|---|---|---|---|
| `kind` | 20/20 | 17/17 | 20/20 |
| `title` | 20/20 | 17/17 | 20/20 |
| `status` | 20/20 | 17/17 | 20/20 |
| `at` | 14/20 | 15/17 | 18/20 |
| `until` | 14/20 | 15/17 | **2/20** |
| `place` | 14/20 | 15/17 | 7/20 |
| `leaveBy` | **13/20** | **0/17** | **4/20** |
| `travel` | 13/20 | 0/17 | 4/20 |
| `intention` | 17/20 | 14/17 | 11/20 |
| `oneRule` | 17/20 | 5/17 | 9/20 |
| `numbers` | 17/20 | 12/17 | 9/20 |
| `bring` | **5/20** | **0/17** | 2/20 |
| `sport` | — | — | 7/20 |
| `note` | — | — | 6/20 |
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

🔴 **`leaveBy` — the field this whole app is built around — reads 13/20, 0/17 and 4/20 across the
three.** The app falls back to `at`, and to no clock at all when there is neither. A design that
assumes it is wrong on the first rest day. Three independent measurements now say so.

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

## What this app publishes, and why the rest is dropped

`src/reduce.js` holds four allowlists — `SESSION_FIELDS`, `DAY_FIELDS`, `BED_FIELDS` and
`META_FIELDS`. `BED_FIELDS` exists because `pick` does not recurse: naming `bed` in `DAY_FIELDS`
alone would copy the whole object, unknown keys included. They are allowlists,
not deny-lists, so a **new** field appearing upstream cannot start being published by accident.
Everything not on them stays in the artifact, including every field the artifact's own renderer
treats as raw HTML.
