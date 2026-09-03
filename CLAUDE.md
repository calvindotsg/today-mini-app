# today-mini-app

> Developer reference for AI agents and future Claude Code sessions. For what the app is and how to
> run it, see [README.md](./README.md). For the PR bar, see [CONTRIBUTING.md](./CONTRIBUTING.md).

New here? Read [The five traps](#the-five-traps) before touching anything. Each one has already
cost a session.

## Quick commands

| Task | Command |
|---|---|
| Test | `npm test` (125 tests) |
| Auth suite only | `npm run test:auth` |
| Dev server | `npm run dev` |
| Deploy | `npm run deploy` — CI also does this on merge to `main`, **behind an approval** (trap 2) |
| Publish a week | `node scripts/publish.mjs <week.html> --put` |

## Architecture

```
a Claude session ──► scripts/publish.mjs ──► Cloudflare KV ──► Worker ──► Telegram
 (reads the weekly                                             │
  training artifact)                                           └── validates initData,
                                                                   refuses anyone but the owner
```

| File | What it owns |
|---|---|
| `src/worker.js` | Routes, auth wiring, security headers. The whole server. |
| `src/initdata.js` | Telegram signature validation. Deliberately small so it can be re-read against the docs in a minute — do not spread it across helpers. |
| `src/reduce.js` | `week-state` → the published payload. Four **allowlists**, so a new upstream field cannot start being published by accident. `BED_FIELDS` is one level down, because `pick` does not recurse. |
| `src/view.js` | payload + a clock → what the two screens show. Pure, no DOM. |
| `src/app.html` | Both screens, in the calvin.sg design system. Templated per request with a CSP nonce. |
| `src/notify.js` | the published payload → the **summary envelope** the Hermes box is sent on a successful `--put`. A named subset picked field by field, never a spread — the artifact grows fields without notice, and a spread would ship each new one to a second machine the week it appeared. |
| `scripts/publish.mjs` | The publisher, and **five content gates**. Refusals: raw markup in a published field; a **wiki path or forecast id** (`models/pace-group`, `F-2026-09-04-a`) — bookkeeping he cannot open; an **abbreviation not spelled out**, satisfied by saying it in full in the same field. Warnings: anything reading like a revision of an earlier plan, and this store's **private vocabulary** (*board*, *anchor*, *dial*). 🔴 The split is the design — an exact shape may refuse, an English guess may only warn. |
| `CONTRACT.md` | The `week-state` shape, **measured** rather than specified. Read before changing `reduce.js`. |

**Two screens, one document.** `Today` answers the 6am question and is what the app opens on; `The
week` carries all seven days and is reached by a chip. There is no second request and no route for
the second screen — the whole week already crosses the auth boundary in the one `POST /s` response,
so there is nothing extra to get the access control right on.

🔴 **The two screens must not disagree about the same day, and the guarantee is STRUCTURAL.**
`renderTodayInFull` in `src/app.html` draws today by calling `renderSlot` and `renderBed` — the
same functions `renderDay` calls, with the same `reveal` argument — so a field added to a week row
appears on the Today screen with no second edit. **Do not copy that markup into a Today-specific
renderer.** Nothing in the suite renders the DOM, so a copy would drift with every test still green;
sharing the function is what makes drift impossible rather than merely unlikely. The Now card is
excluded from the list by `key` (`date#index`), which `view.js` puts on both slices — a session
cannot be matched on `at` (optional) or on `title` (not unique within a day).

⚠️ **The Today screen carries the day; it does not carry `note`.** The artifact prints `note` inside
its own day card, so the two look different there on purpose — see trap 4 for the two independent
reasons that field stays refused.

🔴 **The way back is drawn TWICE on purpose** — Telegram's arrow, plus a `Today` chip at the top of
the week and again at its foot. That looks like the redundancy the design system tells you to cut,
and it is not. The in-page control was once gated on the client being unable to draw an arrow; on a
real iPhone that gate was open, the arrow rendered and was inert, and the week had no exit. See the
comment above `installReceiver` in `src/app.html` for why the arrow was dead. **A way back does not
get to depend on a bridge.**

Two routes and nothing else: `GET /` serves the document; `POST /s` returns the week as JSON to a
validated launch and `401` with a **zero-byte body** to everyone else. Any other path is `404`.

## The five traps

### 1. `.dev.vars` first, or the auth suite lies to you

Gitignored, so absent in every fresh clone and **every new git worktree**. Without
`cp .dev.vars.example .dev.vars` the happy path fails `401 !== 200`, which reads as an
access-control regression rather than a missing file.

### 2. Merging is not shipping — the trap MOVED, it did not go away

The Cloudflare credential landed 2026-09-01, so `deploy production` no longer skips. What replaced
the old gap is an approval: 🔴 **the `production` environment requires a review**, so a merge sits
waiting for a click, and until that click `main` is merged and the edge serves the previous commit.

⚠️ **The alarm for that is now dead code.** `deploy (not configured)` — the job that printed *"main
is merged but NOT shipped"* — fires only when `CLOUDFLARE_ACCOUNT_ID == ''`, which can never be true
again. What does announce it is `drift.yml`, which runs on **every push to `main`** as well as
weekly — measured twice on 2026-09-01, it opened an issue within ten seconds of the merge both
times, and closes it again once the edge catches up. So after merging,
**check the job actually ran**:

```sh
gh run list --limit 3
gh run view <id> --json jobs --jq '.jobs[] | "\(.name)\t\(.conclusion)"'
```

`deploy production: success` is the proof; `pending`, `waiting` or absent means it has not shipped.

Separately, `scripts/publish.mjs` writes KV **directly**, from a laptop, not through this Worker.
The page and the week ship on two independent tracks. CI now runs this digest check itself, but by
hand it is still the thing that settles "is the page live":

```sh
curl -sS https://today.calvin.sg/ | sed 's/nonce="[^"]*"/nonce="N"/g' | shasum -a 256
sed 's/__NONCE__/N/g' src/app.html | shasum -a 256
```

Equal digests prove the deploy shipped exactly what was tested. A grep only proves the one string
you thought to look for survived.

### 3. Every render path sits behind the auth gate

Pointing a browser at `wrangler dev` shows the "open this from your chat" card — `app.html`'s
`launchParams()` finds no `tgWebAppData` and never calls `/s`. To see a real screen:

1. Mint a launch with `mintInitData({})` from `test/helpers.mjs`. Its `FAKE_BOT_TOKEN` matches
   `.dev.vars.example`, so a local `wrangler dev` accepts it.
2. Put it in the **fragment**, encoded once:
   `http://127.0.0.1:<port>/#tgWebAppData=` + `encodeURIComponent(initData)`. `URLSearchParams`
   strips exactly one layer, and the `user` field's own percent-encoding has to survive.
3. ⚠️ `auth_date` is checked against a **15-minute** window. Mint immediately before browsing — a
   URL from twenty minutes ago is a silent 401 and an error card that looks like a code failure.
4. Seed the week into the **emulated** store:
   `npx wrangler@4.127.1 kv key put week:current --path <seed.json> --binding WEEK --local`.
   🔴 `--local` is what keeps real training data out of the experiment.
5. Build seeds off `Date.now()` ± minutes, formatted as naive SGT (`YYYY-MM-DDTHH:MM`). Every
   branch in `view.js` reads the request's own clock, so a fixture with hardcoded dates exercises
   only the empty states.

⚠️ **The suite owns 8799 AND 8801** — `PORT` and `PORT + 2`, the second being the throwaway
instance the *"`ALLOWED_USER_ID` unset"* test spawns. A dev server left on either port does not
collide loudly: the test finds a **correctly-configured** server already listening, gets `200` where
it expects `401`, and fails as *"a valid launch was accepted when the id is unset"* — which reads
like a fail-open bug in the Worker. Use 8802 or higher, and kill it before running the suite.

### 4. `CONTRACT.md`'s frequency table is a frozen sample

It records how often each session field appeared across two artifacts on **2026-08-31**. Upstream
habits move: `until` read 14/20 there and **2/20** in a later live week. Read the table as *which
fields can exist*, never as *how often you will get one*. Only `kind`, `title` and `status` are
genuinely always present. `dist/payload.json` is gitignored, so the drift is invisible from a
clone — get a current sample from the edge with
`npx wrangler@4.127.1 kv key get week:current --binding WEEK --remote --text`.

The reverse also holds: a field can be **published but unread**. Check `reduce.js`'s allowlists
before assuming new data has to be plumbed through — that is exactly what `tag`, `bed` and `sport`
were until the week screen was built, and the artifact had been emitting them for weeks.

🔴 **`note` is refused, and it must stay refused.** It fails on two grounds at once: **2 of 6 notes
in the live week carry literal `<b>` tags** (and this app renders everything with `textContent`, so
they would arrive as visible angle brackets), and it is where the *corrections* live — the one
thing the app is asked never to show. `publish.mjs` now enforces the first mechanically, so a
future field with the same problem is caught rather than noticed.

### 5. Two gates, not one

`validateInitData` returns `ok: true` for **anybody** who opens the app — Telegram signs every
launch with the same bot token. Only the `user.id` comparison decides whose launch it was. Collapse
them and every test still passes while the app admits everyone.

⚠️ Exclude **only** `hash` from the data-check string. `signature` is excluded from the *other*
check (the Ed25519 third-party one). Folding that exclusion into this one fails every real launch
from a modern client while every hand-minted fixture still passes.

## Things that must not be "simplified"

- **A route, not a custom domain.** `custom_domain: true` makes Cloudflare create and manage the
  DNS record. The `calvin.sg` zone is managed as code by octoDNS in `calvindotsg/portfolio-v2`,
  whose weekly drift workflow fails **on purpose** when the live zone and the repo disagree.
- **One document, one nonce.** A CSP nonce cannot survive `document.write` — the written markup is
  judged against the *first* response's policy, so a two-document shell renders blank with no
  error and two successful 200s in the log.
- **`--ignore-scripts` before the specifier** in `.github/workflows/ci.yml`. npm passes everything
  after the package name to the package.
- **`BOT_TOKEN` and `ALLOWED_USER_ID` are secrets, never `vars`**, and the Worker **fails closed**
  without them.

## Testing

`test/view.test.mjs` carries five negative controls: every optional field absent, a day with
nothing actionable left, data past the staleness threshold, an empty `days` array, and a session's
hold running past the next thing to leave for. Without those the app would pass its tests while
showing stale or empty data as though it were today's.

`test/initdata.test.mjs` mints `initData` the way **Telegram** mints it, independently, rather than
by calling the checker's own code — so the suite cannot agree with the checker by construction.
That is not theoretical: it is how the `signature` bug shipped.

The week screen's controls follow the same rule — each was checked by **breaking the code it
guards**. The two that matter most: the past/today/ahead boundary at **00:05 SGT** (a UTC
comparison shifts the whole week by a row, every morning, for eight hours) and an **unknown key
inside `bed`** (the allowlist has to reach one level down, because `pick` does not recurse).

⚠️ **A control that cannot fail is worse than none.** *"Every status prints its own word"* was
dropped as a view test — nothing here renders the DOM, so it would have passed with the week screen
printing no status word at all. The mapping lives in `view.js` for exactly that reason.

⚠️ **`npm test` overwrites `dist/payload.json`**, because `publish.test.mjs` runs the real
publisher. Re-run `scripts/publish.mjs` before seeding a local KV from that file, or you will seed
a one-day fixture and spend a while wondering why the week screen has one row.
