# today-mini-app

> Developer reference for AI agents and future Claude Code sessions. For what the app is and how to
> run it, see [README.md](./README.md). For the PR bar, see [CONTRIBUTING.md](./CONTRIBUTING.md).

New here? Read [The five traps](#the-five-traps) before touching anything. Each one has already
cost a session.

## Quick commands

| Task | Command |
|---|---|
| Test | `npm test` (196 tests) — **serialised**, see below |
| Auth suite only | `npm run test:auth` (Telegram) · `npm run test:web` (browser/PWA) |
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
| `src/access.js` | Cloudflare Access JWT validation, for the browser way in. Small for the same reason. It PROVES the token; `worker.js` decides whose it is. 🔴 The account runs other Access apps on the same issuer and signing keys, so `aud` is the only thing separating their tokens from this one. |
| `src/session.js` | The first-party session cookie the Worker mints after Access. Two lifetimes: 30-day sliding, 90-day hard ceiling anchored to first sign-in. |
| `src/reduce.js` | `week-state` → the published payload. Four **allowlists**, so a new upstream field cannot start being published by accident. `BED_FIELDS` is one level down, because `pick` does not recurse. |
| `src/view.js` | payload + a clock → what the two screens show. Pure, no DOM. |
| `src/app.html` | Both screens, in the calvin.sg design system. Templated per request with a CSP nonce. |
| `src/notify.js` | the published payload → the **summary envelope** the Hermes box is sent on a successful `--put`. A named subset picked field by field, never a spread — the artifact grows fields without notice, and a spread would ship each new one to a second machine the week it appeared. |
| `scripts/publish.mjs` | The publisher, and **five content gates**. Refusals: raw markup in a published field; a **wiki path or forecast id** (`models/pace-group`, `F-2026-09-04-a`) — bookkeeping he cannot open; an **abbreviation not spelled out**, satisfied by saying it in full in the same field. Warnings: anything reading like a revision of an earlier plan, and this store's **private vocabulary** (*board*, *anchor*, *dial*). 🔴 The split is the design — an exact shape may refuse, an English guess may only warn. |
| `CONTRACT.md` | The `week-state` shape, **measured** rather than specified. Read before changing `reduce.js`. |

**Two screens, one document.** `Today` answers the 6am question and is what the app opens on; `Week`
carries all seven days and is reached from the navigation bar. There is no second request and no
route for the second screen — the whole week already crosses the auth boundary in the one `POST /s`
response, so there is nothing extra to get the access control right on.

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

🔴 **The way back must never depend on a bridge.** It was once gated on the client being unable to
draw Telegram's arrow; on a real iPhone that gate was open, the arrow rendered and was **inert**, and
the week had no exit. See the comment above `installReceiver` in `src/app.html` for why it was dead.

⚠️ **What satisfies that rule CHANGED in #27, so the old wording no longer describes the app.** It
used to be two in-page `Today` chips, at the head and the foot of the week. Both are gone. A fixed
**Liquid Glass navigation bar** now sits in the thumb zone on both screens — drawn by this page, from
this page's own data, on screen at every scroll position. Telegram's arrow is still set up and still
routed, so the way back is still drawn twice; the second copy is simply no longer scroll-dependent.

🔴 **`renderNav` hides the bar on `!view.ok` and NOTHING ELSE**, and that line is load-bearing in two
directions. Apple: *"Don't disable or hide tab bar buttons, even when their content is unavailable…
If a section is empty, explain why."* So a published plan with **no days** keeps both tabs and the
Week screen explains itself. A **refusal** has no sections at all, and there a tab is a control that
lies — this page's own rule, from the past-day disclosure. Reaching for `hasWeek()` here instead
silently takes Apple's case away; `worker.http.test.mjs` pins the exact condition for that reason.

🔴 **`.navbar[hidden]{display:none}` is not redundant with the attribute — it IS the attribute.**
`hidden` is a UA rule at the lowest specificity there is, and `.navbar` sets `display:flex` on a
class, which beats it. Without that rule `navEl.hidden = true` sets the attribute and does nothing,
and the refusal screen draws an empty nine-pixel glass sliver. It shipped that way in #27, was live
on both routes, and 178 passing tests could not see it because nothing here renders the DOM.

Two routes for Telegram: `GET /` serves the document; `POST /s` returns the week as JSON to a
validated launch and `401` with a **zero-byte body** to everyone else.

**And a second way in, for a browser and an iOS home-screen app.** Cloudflare Access gates exactly
ONE path, `GET /web/signin`; the Worker verifies that JWT itself, checks the email, and mints its own
cookie. `GET /web/` and `POST /web/s` are gated by that cookie alone.

🔴 **`GET /web/` answers 200 in EVERY auth state and never redirects.** It is the installed app's
`start_url`, and a standalone app has no address bar, no reload and no back button — so a redirect to
`/web/signin` would hand the launch itself to Access and then to another origin before any gesture,
leaving a chrome-less error with no way out. Logged out, it serves the same document with no plan
data and the client draws a *Sign in* link the reader taps.

🔴 **`/` and `/web/` serve a BYTE-IDENTICAL document**, asserted by the suite. The mode is derived on
the client from `location.pathname` — see "one template token" below. Any other path is `404`.

## The five traps

### 1. `.dev.vars` first, or the auth suite lies to you

Gitignored, so absent in every fresh clone and **every new git worktree**. Without
`cp .dev.vars.example .dev.vars` the happy path fails `401 !== 200`, which reads as an
access-control regression rather than a missing file.

⚠️ **The example gained four more entries** — `SESSION_SECRET`, `ALLOWED_EMAIL`, `ACCESS_AUD`,
`ACCESS_TEAM_DOMAIN` — so a `.dev.vars` copied before they existed is missing all four. They gate
**`/web/*` and nothing else**: `worker.js` keeps `configuredWeb` separate from `configured` for
exactly this reason, so a stale copy still passes the Telegram suite and only the browser tests go
red. 🔴 **Do not fold them into `configured`.** That would turn a missing local file into this trap's
misleading signature for every clone and worktree in existence.

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

🔴 **The browser way in has the SAME shape, and it is easy to collapse.** `access.js` proves the
Access JWT; only the `email` comparison in `worker.js` decides whose it is — and that comparison runs
on **every `/web/*` request**, not just at sign-in. An earlier draft checked it only when minting,
which made the cookie the authorisation rather than a pointer to it: changing `ALLOWED_EMAIL` or
deleting the Access policy would then have revoked nothing for thirty days. And `aud` is the only
thing separating this app's tokens from the account's two Hermes apps, which share an issuer and
signing keys — so a Hermes token is genuinely Cloudflare-signed. `String(aud).includes()` passes on a
superstring; it must be an exact match against an element of the array.

## Things that must not be "simplified"

- 🔴 **ONE TEMPLATE TOKEN IN `src/app.html`, AND IT IS THE NONCE.** `ci.yml:185` and `drift.yml:51`
  both prove the deploy by hashing the source with only the nonce placeholder normalised, against the
  live page normalised on `nonce="..."` alone. A SECOND per-request substitution makes those digests
  disagree for ever: every deploy reports red while shipping fine, and `drift.yml` opens a
  Deploy-drift issue on every push to `main` — and `drift.yml` is the replacement for trap 2's dead
  alarm, so that is the whole live shipping alarm gone. Need per-request behaviour in the document?
  **Derive it on the client** (`location.pathname`), which is also what keeps `/` and `/web/`
  byte-identical.
  ⚠️ **This includes COMMENTS.** The Worker substitutes every occurrence in the file, so a comment
  naming the placeholder gets a fresh random value on each request. That very nearly shipped — inside
  a comment explaining this rule. `webauth.http.test.mjs` now runs CI's exact comparison locally,
  because CI would only have caught it after a deploy had already gone red.
- 🔴 **Two account-level Cloudflare settings can kill the Mini App from outside this repository.**
  `deny_unmatched_requests` (currently `false`) would start denying `/` and `POST /s`. Read it with
  `cf zero-trust organizations list`; the remedy is the very next field,
  `deny_unmatched_requests_exempted_zone_names` — an exempted zone still gates subdomains that DO
  have an application, so exempting `calvin.sg` keeps `/` and `/s` public while `/web/signin` stays
  gated. Separately, the Access app's **cookie path attribute** is what keeps `CF_Authorization` off
  `/` and `/s`; host-scoped by default, it otherwise reaches this Worker on every public request.
- ⚠️ **`npm test` is serialised (`--test-concurrency=1`) and must stay that way.** Two suites now each
  spawn a real `wrangler dev`; racing them makes startup exceed the 90-second wait and the whole web
  suite fails at once, which reads as a Worker fault rather than contention.

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

📌 **A second one was retired the same way, and the mutation check is what found it.**
`docs.test.mjs` first carried a separate *"each document states the size exactly once"* test
alongside its main assertion. No mutation could fail it **alone** — a README reading 181 while the
suite has 182 satisfies it perfectly — so it added no detection power and one to the count it was
policing. Its job now lives in the shape of the main assertion: `deepEqual` against a one-element
array, which fails on no match, the wrong number, **and** a second mention.

🔴 **`test/docs.test.mjs` reconciles the test count with the three documents that print it.**
`README.md`, `CONTRIBUTING.md` and this file each state it, and before #37 nothing compared them to
anything: they drifted to 125/178/179 at once, then agreed at 179 while the suite ran 180. **Add a
test and all three go red until you update them** — that is the intended cost, and it is cheaper
than the drift. ⚠️ The count is **static** (`test(` declarations), because a test cannot run its own
suite; that only equals what `node --test` prints while every test is a flat top-level call, so a
third test asserts exactly that and fails the moment anyone reaches for `describe()`.

⚠️ **`npm test` overwrites `dist/payload.json`**, because `publish.test.mjs` runs the real
publisher. Re-run `scripts/publish.mjs` before seeding a local KV from that file, or you will seed
a one-day fixture and spend a while wondering why the week screen has one row.
