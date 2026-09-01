# today-mini-app

> Developer reference for AI agents and future Claude Code sessions. For what the app is and how to
> run it, see [README.md](./README.md). For the PR bar, see [CONTRIBUTING.md](./CONTRIBUTING.md).

New here? Read [The five traps](#the-five-traps) before touching anything. Each one has already
cost a session.

## Quick commands

| Task | Command |
|---|---|
| Test | `npm test` (47 tests) |
| Auth suite only | `npm run test:auth` |
| Dev server | `npm run dev` |
| Deploy | `npm run deploy` — CI also does this on merge to `main` |
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
| `src/reduce.js` | `week-state` → the published payload. Two **allowlists**, so a new upstream field cannot start being published by accident. |
| `src/view.js` | payload + a clock → what the one screen shows. Pure, no DOM. |
| `src/app.html` | The one screen, in the calvin.sg design system. Templated per request with a CSP nonce. |
| `CONTRACT.md` | The `week-state` shape, **measured** rather than specified. Read before changing `reduce.js`. |

Two routes and nothing else: `GET /` serves the document; `POST /s` returns the week as JSON to a
validated launch and `401` with a **zero-byte body** to everyone else. Any other path is `404`.

## The five traps

### 1. `.dev.vars` first, or the auth suite lies to you

Gitignored, so absent in every fresh clone and **every new git worktree**. Without
`cp .dev.vars.example .dev.vars` the happy path fails `401 !== 200`, which reads as an
access-control regression rather than a missing file.

### 2. Merging is not shipping

CI now deploys `main` and asserts the edge serves that commit, so this is much less sharp than it
was — but `scripts/publish.mjs` writes KV **directly**, from a laptop, not through this Worker. The
page and the week ship on two independent tracks. The only check that settles "is it live":

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
before assuming new data has to be plumbed through.

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
