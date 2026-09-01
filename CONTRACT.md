# The `week-state` contract, as measured

**This app does not own this contract.** It is written by the *My Running Advisor* Claude project
into a weekly artifact, and it can change without warning or notice. Everything below is a
measurement of two real artifacts on 2026-08-31, not a specification anybody agreed to. The
consequence is baked into `src/reduce.js`: a shape it does not recognise is **refused**, loudly,
rather than published half-understood.

Measured from:

| | shape | week |
|---|---|---|
| **A** | the live **plan** page | 24–30 Aug 2026 |
| **B** | a **closeout** page | 17–23 Aug 2026 |

The two artifacts are private pages in the Claude project that writes them, so they are identified
here by shape rather than by id. Nothing below depends on being able to open them — the table is
the measurement.

## The finding that matters most

**A and B are two different document types, not two instances of one.** The plan's step 2 called
them "current week" and "previous week"; they do not share a top-level shape.

| top-level key | A (plan) | B (closeout) |
|---|---|---|
| `meta` `days` `prose` | ✅ | ✅ |
| `intent`, `actions` | ✅ | — |
| `verdict`, `changed` | — | ✅ |

So **two artifacts is a sample of two shapes, not of two weeks.** Only `meta`, `days` and
`prose` can be relied on at all, and inside them only what is present in both. A third artifact
would be a better sample than either of these; there is no third.

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

Always 7 entries in both. Present in both: `date` (`YYYY-MM-DD`), `dow`, `tags`, `sessions`.
`photo` is optional (3 of 7 in both).

⚠️ **`day.state` is present on all 7 days of A and on none of B.** A renderer keyed on it is
wrong on the first closeout. `day.key` is likewise A-only. This app reads neither.

## `days[].sessions[]`

**Three fields are always present. Everything else is optional.**

| field | A | B |
|---|---|---|
| `kind` | 20/20 | 17/17 |
| `title` | 20/20 | 17/17 |
| `status` | 20/20 | 17/17 |
| `at` | 14/20 | 15/17 |
| `until` | 14/20 | 15/17 |
| `place` | 14/20 | 15/17 |
| `leaveBy` | **13/20** | **0/17** |
| `travel` | 13/20 | 0/17 |
| `intention` | 17/20 | 14/17 |
| `oneRule` | 17/20 | 5/17 |
| `numbers` | 17/20 | 12/17 |
| `bring` | **5/20** | **0/17** |
| `actual` | 10/20 | 12/17 |
| `spec` | 20/20 | 4/17 |
| `why` | 20/20 | 9/17 |
| `means` | 17/20 | 0/17 |
| `miss` | 7/20 | 0/17 |
| `planKm` | 4/20 | 5/17 |
| `photo` | 4/20 | 3/17 |
| `watch` | 2/20 | 2/17 |
| `link` | 2/20 | 0/17 |
| `machines` | 1/20 | 0/17 |

🔴 **`leaveBy` — the field this whole app is built around — is present on 13 of 20 sessions in
one artifact and 0 of 17 in the other.** The app falls back to `at`, and to no clock at all when
there is neither. A design that assumes it is wrong on the first rest day.

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
- `spec` — `string[][]` — **not published**; the artifact's own renderer treats parts of it as raw
  HTML, and nothing raw crosses into this app
- `tags` — `{t, c}[]` where `c` ∈ `good` `grey` `cap` `heat` `""` — **not published**

## Times and timezone

`at`, `until` and `leaveBy` are **naive local ISO** — `"2026-08-28T18:30"`, no offset, no seconds.
They are Singapore time. Singapore has had a fixed **+08:00** since 1982 and no DST, so
`src/view.js` reads them at a fixed offset: exact here, not an approximation.

## What this app publishes, and why the rest is dropped

`src/reduce.js` holds two allowlists — `SESSION_FIELDS` and `META_FIELDS`. They are allowlists,
not deny-lists, so a **new** field appearing upstream cannot start being published by accident.
Everything not on them stays in the artifact, including every field the artifact's own renderer
treats as raw HTML.
