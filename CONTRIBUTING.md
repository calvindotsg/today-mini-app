# Contributing

This is a personal app with one user, so "contributing" mostly means *future me, or an agent
working on my behalf*. The conventions below exist because each one has already cost something.

## Development setup

```bash
git clone https://github.com/calvindotsg/today-mini-app
cd today-mini-app
cp .dev.vars.example .dev.vars   # ← do this FIRST, see below
npm test
```

There is nothing to install. This repository declares **zero dependencies** and has no lockfile —
the Worker is five source files on the Workers runtime, and the only third-party code that ever
runs is `wrangler`, which `npx` fetches at run time.

🔴 **`cp .dev.vars.example .dev.vars` is not optional and does not look load-bearing.**
`wrangler dev` reads Worker secrets from `.dev.vars`, which is gitignored and therefore absent in
every fresh clone and every new git worktree. Without it `test/worker.http.test.mjs` fails its happy
path with `401 !== 200` — which reads exactly like an access-control regression and sends you
hunting through `src/initdata.js` instead of at the missing file. The example holds a **fake**
token; the suite mints its own `initData` against it, so no real bot credential is needed to
exercise every auth path.

⚠️ **The example gained four entries for the browser way in** — `SESSION_SECRET`, `ALLOWED_EMAIL`,
`ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. If your `.dev.vars` predates them, copy the example again.
All four are fakes like the two above: the suite mints its own Access tokens against a local key
server and its own session cookies with that key, so no real credential is needed here either, and
this repository still carries no personal identifier.

They gate **`/web/*` and nothing else** — `worker.js` keeps `configuredWeb` separate from
`configured` deliberately, so a stale `.dev.vars` still passes the Telegram suite and only the
browser tests go red. Please keep that separation if you add a secret: folding a new one into
`configured` turns a missing local file into the confusing `401 !== 200` above for every clone that
exists.

| Command | What it does |
| --- | --- |
| `npm test` | The whole suite, 196 tests. **Serialised** — two suites each spawn a real `wrangler dev`, and racing them makes startup exceed its 90-second wait |
| `npm run test:auth` | Just the Telegram HTTP auth suite, against the real Worker in the real runtime |
| `npm run test:web` | The same, for the browser and home-screen way in |
| `npm run dev` | `wrangler dev` on the emulated KV |
| `npm run deploy` | Ships to `today.calvin.sg`. CI does this on merge — see below |
| `npm run publish:week` | Reduces a weekly artifact and writes it to KV |

🔴 **That number is enforced, so adding a test turns this table red.** `test/docs.test.mjs` counts
the suite and compares it against the figure in this file, `README.md` and `CLAUDE.md` — all three
state it, and none of them used to be checked against anything. Update all three; the failure
message names the file and both numbers. If you reword the line, fix the pattern in that test
rather than deleting the check.

## Commit conventions

[Conventional Commits](https://www.conventionalcommits.org/), **lowercase subject, no scope** —
match the voice in `git log`, which is a sentence about what changed for the reader rather than a
label for the diff:

```text
feat: the session you are in stays on the screen until it is over
fix: `signature` belongs IN the data-check-string, and the suite agreed with the bug
```

Squash is the only merge method enabled, so **the PR title is the commit that lands on `main`** and
must itself be a valid conventional commit. Do not put the PR number in it — the squash merge
appends one.

Suggested types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`. Dependabot uses
`ci(deps):` for action bumps.

## Pull requests

`main` is protected: pull requests only, no force pushes, no branch deletion, and the **`test`**
check must pass. Every commit on `main` arrived this way.

The bar for a PR body here is higher than the template asks for, and it is set by the merged ones —
read `gh pr view <n> --json body` before writing your first. **Summary / Problem / Solution / Test
Plan**, and in the test plan:

- **Counts as measured, never estimated.** "47 tests, 47 pass, 0 fail (43 on `main`)".
- 🔴 **A mutation check.** A new test that passes proves nothing about whether it would have caught
  the bug. Break the fix, confirm the new tests fail and **no others**, restore, re-run green.
  Report it as a table of *mutation → tests that fail*. This matters here specifically because
  `src/view.js` is pure and its tests are all clock arithmetic: a chosen `nowMs` that happens to
  sit on the right side of both the old rule and the new one goes green for the wrong reason and
  looks identical to one that goes green for the right one.
- 🔴 **At least one honest unticked box.** A test plan with nothing open reads as a claim nobody
  checked. The one that stays open here is a **real Telegram client** — it needs a phone and the
  real bot token.

  ⚠️ **That box is not a formality, and #9 proved it.** It shipped with exactly that line open, and
  the phone then found two defects a browser could not: Telegram's back arrow rendered and did
  nothing, and the in-page fallback was gated on the arrow working. Both were invisible to 65
  passing tests and to a browser check at four viewport widths. When the open box is the one your
  change actually depends on, say so in those words rather than leaving it as boilerplate.

## Two things that are easy to get wrong

**Merging is not shipping, and the gap has moved rather than closed.** CI deploys `main` to
`today.calvin.sg` after the tests pass and asserts the edge is actually serving that commit — but
🔴 **the `production` environment requires a review**, so a merge parks at *Waiting* until someone
clicks. Until then `main` is merged and the edge serves the previous commit. Finishing a PR here
means watching `deploy production` reach `success`, not watching the merge land:

```sh
gh run list --limit 3
gh run view <id> --json jobs --jq '.jobs[] | "\(.name)\t\(.conclusion)"'
```

`scripts/publish.mjs` still writes the week to KV *directly*, from a laptop, so the page and the
data ship on two independent tracks and either can be stale while the other is current.
`.github/workflows/drift.yml` watches for exactly that, on every push to `main` and weekly.

**A stranger's `initData` is cryptographically valid.** Telegram signs every launch with the same
bot token, so the signature only proves the launch is real — a `user.id` comparison is what decides
whose it was. They are two gates and the suite keeps them apart. The test worth writing is *"a
correctly-signed launch belonging to somebody else is refused"*, and it is the one most likely to
be skipped. Assert an **empty body** on every rejection, not just the status.
