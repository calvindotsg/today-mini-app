# today.calvin.sg

A Telegram Mini App that answers one question from inside the chat with
[@calvindotsg_bot](https://t.me/calvindotsg_bot): **what's on today, and what's next.**

Not a dashboard. Strava and Garmin Connect already cover history, splits and volume. What no
other app can show is *the plan* — where to be, and **what time to leave**, which is the number
that changes behaviour at 6am.

One screen. One session, the one after it, and an honest line when neither exists.

---

## The architecture, and the reason for it

```
  a Claude session ──► scripts/publish.mjs ──► Cloudflare KV ──► Worker ──► Telegram
   (reads the weekly                                              │
    training artifact)                                            └── validates initData,
                                                                      refuses anyone but Calvin
```

The training assistant this belongs to runs on a Hetzner box whose firewall carries **zero
rules** — nothing inbound reaches it, and its egress goes through an eleven-host allowlist.
Serving this app from that box would be the first open door on a machine that has none.

So it is served from the edge instead, and it holds **one week of a training plan and nothing
else**. If this Worker were fully compromised, an attacker gets Calvin's session times. Not the
server, not a credential for it, not the agent. That containment is the design, not a
side effect — see `wrangler.jsonc` and `src/worker.js`, which both say so at the point it
would be easy to widen.

## How a stranger is kept out

Telegram signs every launch. The Worker checks that signature and then checks who it is for:

1. HMAC-SHA256 over the launch parameters, keyed by `HMAC(bot_token, "WebAppData")`, compared in
   **constant time** (`src/initdata.js`).
2. `auth_date` no more than **15 minutes** old, so a captured launch cannot be replayed later.
3. `user.id` equal to the configured id — **the actual access control.** Steps 1 and 2 prove the
   launch is real; only this decides whose it was.

A failure at any step is `401` with a **zero-byte body** and no content type. `test/worker.http.test.mjs`
asserts the body length on every rejection, because a 401 that still ships the page is a real bug.

### Why there is a shell at all

Telegram puts the launch parameters in the URL **fragment**, which is never sent to a server. No
server can validate a Mini App launch on the first GET — so `src/bootstrap.html` reads the
fragment and POSTs it. That shell holds **no plan, no design system and no allowlist**: a test
asserts it contains none of the plan's vocabulary and stays under 4 KB. The app and the week's
data arrive together, in one authenticated response, so there is no data endpoint to attack.

## Setup

```bash
npx wrangler kv namespace create WEEK        # once; put the id in wrangler.jsonc
npx wrangler secret put BOT_TOKEN            # @calvindotsg_bot's token, from 1Password
npx wrangler secret put ALLOWED_USER_ID      # the one Telegram user id allowed in
npx wrangler deploy
```

Both are **secrets**, never `vars`: one is the bot's whole identity, and the other is a personal
identifier this repository has no reason to carry. The Worker **fails closed** without them —
`test/worker.http.test.mjs` proves a valid launch is still refused when `ALLOWED_USER_ID` is
unset, which is the mistake that would otherwise make the app public.

The hostname resolves through a **proxied AAAA record in
[`calvindotsg/portfolio-v2`](https://github.com/calvindotsg/portfolio-v2)'s octoDNS zone**, added
by pull request. This Worker attaches with a **route**, not a custom domain, so it never writes
DNS — see the comment in `wrangler.jsonc` for what breaks if that is "simplified".

## Publishing a week

```bash
node scripts/publish.mjs ~/path/to/week.html --put
```

**A cron cannot do this.** The week lives in a private Claude artifact, readable only by a Claude
session — the box has no route to `claude.ai`, and a script on the Mac has no credential for it.
So publishing is on demand: a Claude session saves the artifact and runs the publisher when the
week's plan is written or revised.

That is exactly why the app treats freshness as something to **state**, not assume. It shows two
different kinds of out-of-date, separately, because conflating them hides the worse one:

- **stale** — the push is more than 18 hours old.
- **not this week** — the plan's own `weekStart`/`weekEnd` do not contain today. A plan pushed an
  hour ago for last week is *fresh and useless*, and only the second banner says so.

### Payload size

The publisher pushes the **whole week**, reduced to twelve fields per session:
**12.4 KB** for a real week (3.9 KB brotli on the wire), against the plan's 8 KB target.

That target assumed a three-day slice baked in at publish time. With an on-demand publisher a
baked slice is correct on the day it is pushed and useless by Wednesday, so the **Worker** slices
to today-and-the-next-two per request instead, and the payload has to carry the week. Measured:
the week cannot fit in 8 KB with the fields the app needs — `intention` and `numbers` alone are
45% of it. The publisher enforces a **24 KB ceiling** and refuses above it.

## Tests

```bash
npm test          # 34 assertions
```

- `test/initdata.test.mjs` — the signature algorithm, against initData minted the way Telegram
  mints it rather than by the checker's own code.
- `test/view.test.mjs` — the four negative controls: every optional field absent, a day with
  nothing actionable left, data past the staleness threshold, and an empty `days` array. Without
  these the app would pass its tests while showing stale or empty data as though it were today's.
- `test/worker.http.test.mjs` — the real Worker in the real runtime, over HTTP. **The case that
  matters is a correctly-signed launch belonging to somebody else**; a suite that only checks the
  happy path proves nothing about an access control.

## Files

| | |
|---|---|
| `src/worker.js` | routes, auth, security headers. The whole server. |
| `src/initdata.js` | Telegram signature validation. Deliberately small so it can be re-read against the docs in a minute. |
| `src/reduce.js` | week-state → the published payload. Two allowlists. |
| `src/view.js` | payload + a clock → what the one screen shows. Pure; no DOM. |
| `src/bootstrap.html` | the contentless shell. |
| `src/app.html` | the one screen, in the calvin.sg design system. |
| `scripts/publish.mjs` | the publisher. |
| `CONTRACT.md` | the `week-state` shape, **measured** across two artifacts. Read this before changing `reduce.js`. |

## If this is ever retired

**Delete the KV data** rather than leaving it. It is a copy of personal training data at the
edge, and a store nobody reads is still a store somebody could.

```bash
npx wrangler kv key delete week:current --binding WEEK --remote
```
