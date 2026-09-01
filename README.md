# today.calvin.sg

[![today.calvin.sg live](https://img.shields.io/website?url=https%3A%2F%2Ftoday.calvin.sg&label=today.calvin.sg&up_message=live&down_message=down)](https://today.calvin.sg)
[![Build status](https://img.shields.io/github/actions/workflow/status/calvindotsg/today-mini-app/ci.yml?branch=main&label=build)](https://github.com/calvindotsg/today-mini-app/actions/workflows/ci.yml)
[![Last commit](https://img.shields.io/github/last-commit/calvindotsg/today-mini-app/main?label=last%20commit)](https://github.com/calvindotsg/today-mini-app/commits/main/)
[![License](https://img.shields.io/github/license/calvindotsg/today-mini-app)](./LICENSE)

Hi, I am Calvin. I run and ride before sunrise, and a training assistant writes my week as a
Claude artifact. This is the one screen that answers the only question I have at 6am, from inside
my chat with [@calvindotsg_bot](https://t.me/calvindotsg_bot): **what's on today, and what time do
I leave.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/preview-dark.png">
  <img alt="The one screen: a threshold run, with LEAVE BY 17:12 set in the largest type on the page, the place and travel time under it, and tomorrow's session in a Next card below" src="docs/preview-light.png">
</picture>

Not a dashboard. Strava and Garmin Connect already cover history, splits and volume. What no other
app can show me is *the plan* — where to be, and **what time to leave**, which is the number that
changes what I actually do.

## Overview

Two screens. **Today** opens first and answers the 6am question; **The week** is one tap away and
carries the rest of the plan, so I no longer open the artifact to see what Thursday looks like.

| | What it shows |
| --- | --- |
| **Now** | The session I am in, or the next one I have to leave for. `Leave by` where the plan states one, the start time where it does not, and `Until` while a session is under way. Place, travel time, the one rule for the session, and what to bring |
| **Next** | The one after it, so I can see whether tonight commits me to a 6am tomorrow |
| **Neither** | An honest line. A rest day says so; a plan that does not cover today says *that*, separately from a plan that is merely old |
| **The week** | All seven days: the volume against its ceiling, each day's character and bedtime, and every session with its times, place, figures, the rule decided before the start, and why it exists. Days already spent collapse to one line — what a finished day settled is what the weekly artifact is for |

Getting back is Telegram's own back arrow. The page reads `tgWebAppVersion` out of the launch to
know whether the client can draw one (Bot API 6.1+), and only draws its own `Today` control when it
cannot — so a current client gets one way back rather than two.

The session in front of me **stays** in front of me while it is under way — until the plan's own
`until`, or a bounded grace where it states none, and never past the moment the next session claims
me.

Three theme states, applied before first paint: system, light, dark. The page also tells Telegram
what colour it is painted, so the chrome above it matches instead of seaming.

## Background

The training assistant this belongs to runs on a box whose firewall carries **zero inbound rules** —
nothing reaches it — and whose egress goes through a short allowlist. Serving this app from there
would be the first open door on a machine that has none.

So it is served from the edge instead, and it holds **one week of a training plan and nothing
else**:

```
  a Claude session ──► scripts/publish.mjs ──► Cloudflare KV ──► Worker ──► Telegram
   (reads the weekly                                             │
    training artifact)                                           └── validates initData,
                                                                     refuses anyone but me
```

If this Worker were fully compromised, an attacker gets my session times. Not the server, not a
credential for it, not the agent. **That containment is the design, not a side effect** — and both
`wrangler.jsonc` and `src/worker.js` say so at the exact point where widening it would be tempting.

## How a stranger is kept out

Telegram signs every launch. The Worker checks that signature and then checks who it is for:

1. HMAC-SHA256 over the launch parameters, keyed by `HMAC(bot_token, "WebAppData")`, compared in
   **constant time** (`src/initdata.js`).
2. `auth_date` no more than **15 minutes** old, so a captured launch cannot be replayed later.
   Future-dated launches are refused too.
3. `user.id` equal to the configured id — **the actual access control.** Steps 1 and 2 prove the
   launch is real; only this decides whose it was.

Step 3 is the one worth stating plainly, because it is counter-intuitive: **a stranger's `initData`
is cryptographically valid.** Telegram signs every launch with the same bot token, so a suite that
only tests the signature passes completely while the app admits everyone. The test that matters is
*a correctly-signed launch belonging to somebody else*, and it is the one most likely to be skipped.

A failure at any step is `401` with a **zero-byte body** and no content type.
`test/worker.http.test.mjs` asserts the body length on every rejection, because a 401 that still
ships the page is a real bug and an easy one to write.

### Why an unauthenticated visitor still gets a page

Telegram puts the launch parameters in the URL **fragment**, which is never sent to a server. No
server can validate a Mini App launch on the first `GET` — so some document is always served before
anyone is proven.

This used to be a contentless shell that replaced itself with the real page. That design is wrong
behind a nonce-based CSP and fails silently: `document.write` does not create a new document, so
the written markup is judged against the *first* response's policy, the second nonce matches
nothing, every inline style and script is dropped, and the result is a blank page on an unstyled
background — with two successful 200s in the log.

So: **one document, one nonce.** `GET /` carries the design and the renderer and **no training
data**. `POST /s` returns the week as JSON to a validated launch and 401-empty to everyone else.
The defensible property is *no user data without auth*, and a test asserts it against distinctive
values seeded into the store rather than against a guess at what the real content looks like.

## Tech stack

A [Cloudflare Worker](https://developers.cloudflare.com/workers/) with a
[Workers KV](https://developers.cloudflare.com/kv/) namespace, five source files, and **zero
dependencies** — no framework, no bundler, no lockfile. Even `telegram-web-app.js` is avoided: what
it is needed for is three `postEvent` calls over the documented bridge plus a listener for the back
button coming the other way, and if the bridge is missing the page still renders — it just draws
its own way back instead.

`node --test` is the change gate. The hostname resolves through a proxied `AAAA` record in
[`calvindotsg/portfolio-v2`](https://github.com/calvindotsg/portfolio-v2)'s octoDNS zone, added by
pull request; this Worker attaches with a **route**, not a custom domain, so it never writes DNS —
see the comment in `wrangler.jsonc` for what breaks if that is "simplified".

## Getting started

```sh
git clone https://github.com/calvindotsg/today-mini-app
cd today-mini-app
cp .dev.vars.example .dev.vars   # ← first, or the auth suite fails in a confusing way
npm test
```

There is nothing to install. `.dev.vars.example` holds a **fake** bot token, and the suite mints its
own `initData` against it, so every auth path is exercised without a real credential. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for why that copy is load-bearing.

| Command | What it does |
| --- | --- |
| `npm test` | The whole suite, 61 tests |
| `npm run test:auth` | Just the HTTP auth suite, against the real Worker in the real runtime |
| `npm run dev` | `wrangler dev` on an emulated KV |
| `npm run deploy` | Ships to `today.calvin.sg` — CI also does this on merge |
| `npm run publish:week` | Reduces a weekly artifact and writes it to KV |

First-time setup of a fresh deployment:

```sh
npx wrangler kv namespace create WEEK        # once; put the id in wrangler.jsonc
npx wrangler secret put BOT_TOKEN            # the bot's token
npx wrangler secret put ALLOWED_USER_ID      # the one Telegram user id allowed in
npx wrangler deploy
```

## Configuration

| Where | What lives there |
| --- | --- |
| Worker **secrets** | `BOT_TOKEN`, `ALLOWED_USER_ID`. Never `vars` — one is the bot's whole identity, and the other is a personal identifier this repository has no reason to carry |
| `wrangler.jsonc` | The route, the KV binding, the compatibility date. No secrets, no observability — the only interesting request carries a launch credential, and the cheapest way to never log it is to log nothing |
| GitHub environment `production` | `CLOUDFLARE_API_TOKEN` for the deploy, behind a branch policy limited to `main` |
| GitHub variable | `CLOUDFLARE_ACCOUNT_ID` — a variable rather than a secret, because masking a value that appears in wrangler's own error output redacts unrelated log lines |

The Worker **fails closed** without its secrets. `test/worker.http.test.mjs` proves a valid launch
is still refused when `ALLOWED_USER_ID` is unset, which is the mistake that would otherwise make
the app public on the day someone forgets a `wrangler secret put`.

## Publishing a week

```sh
node scripts/publish.mjs ~/path/to/week.html --put
```

**A cron cannot do this.** The week lives in a private Claude artifact readable only by a Claude
session — the box has no route to `claude.ai`, and a script on my Mac has no credential for it. So
publishing is on demand, when the week's plan is written or revised.

Which is exactly why the app treats freshness as something to **state** rather than assume. It
shows two different kinds of out-of-date, separately, because conflating them hides the worse one:

- **stale** — the push is more than 18 hours old.
- **not this week** — the plan's own `weekStart`/`weekEnd` do not contain today. A plan pushed an
  hour ago for last week is *fresh and useless*, and only the second banner says so.

The publisher pushes the **whole week**, reduced to twelve fields per session — 12.4 KB for a real
week, 3.9 KB brotli on the wire — and refuses above a 24 KB ceiling. The Worker slices to
today-and-the-next-two per request, because a slice baked in at publish time is correct on the day
it is pushed and useless by Wednesday.

## Testing

```sh
npm test          # 61 tests
```

- `test/initdata.test.mjs` — the signature algorithm, against `initData` minted the way **Telegram**
  mints it rather than by the checker's own code. That is not a stylistic choice: an earlier version
  folded `signature` into the data-check string, which broke every launch from a real client while
  every hand-minted fixture still passed.
- `test/view.test.mjs` — negative controls, which are most of the file. The original five: every
  optional field absent, a day with nothing actionable left, data past the staleness threshold, an
  empty `days` array, and a session's hold on the screen running past the next thing I have to
  leave for. The week screen added more, and two are worth naming — **the past/today/ahead boundary
  at 00:05 Singapore time**, which a UTC comparison gets wrong every morning for eight hours, and
  **an unknown key inside `bed`**, which the allowlist has to drop even though `pick` does not
  recurse. Each was checked by breaking the code it guards and watching it fail.
- `test/publish.test.mjs` — the publisher's two content gates, by running the publisher.
- `test/worker.http.test.mjs` — the real Worker in the real runtime, over HTTP.

One control was deliberately **not** written: *"every status prints its own word."* Nothing in the
suite renders the DOM, so at view level it could only assert `status` passed through unchanged —
and would have passed even if the week screen printed no status word at all. The mapping moved into
`src/view.js` instead, where a test can actually fail.

CI runs the suite on Node 22, 24 and 26, then deploys `main` and asserts the edge is serving that
exact commit. ⚠️ **The `production` environment requires a review**, so a merge does not ship on its
own — it waits for an approval, and until that click `main` is merged and the edge is still serving
the previous commit. `.github/workflows/drift.yml` re-checks weekly, because `scripts/publish.mjs`
writes KV directly and the page and the data ship on two independent tracks.

## Files

| | |
|---|---|
| `src/worker.js` | Routes, auth, security headers. The whole server |
| `src/initdata.js` | Telegram signature validation. Deliberately small so it can be re-read against the docs in a minute |
| `src/reduce.js` | week-state → the published payload. Two allowlists |
| `src/view.js` | payload + a clock → what the one screen shows. Pure; no DOM |
| `src/app.html` | The one screen, in the calvin.sg design system |
| `scripts/publish.mjs` | The publisher |
| `CONTRACT.md` | The `week-state` shape, **measured** across two artifacts. Read this before changing `reduce.js` |
| `CLAUDE.md` | Reference for agents working in this repository |

## If this is ever retired

**Delete the KV data** rather than leaving it. It is a copy of personal training data at the edge,
and a store nobody reads is still a store somebody could.

```sh
npx wrangler kv key delete week:current --binding WEEK --remote
```

## License

[MIT](./LICENSE).
