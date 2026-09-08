// The auth suite that actually matters: the four cases from the plan, run against the REAL
// Worker in the REAL runtime (workerd, via `wrangler dev --local`), over HTTP.
//
// A unit test of validateInitData proves the algorithm. It does NOT prove that the Worker wires
// the user-id check in, that a rejection carries an EMPTY BODY, or that a 401 does not ship the
// page anyway -- which is a real bug and an easy one to write. Every assertion below reads the
// response body and asserts its length, not just the status code.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mintInitData, FAKE_BOT_TOKEN, ALLOWED_ID } from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let dev;

// 🔴 `npx` is a WRAPPER, and signalling it does not signal what it started.
//
// `npx wrangler dev` becomes npx -> sh -> wrangler -> {esbuild, workerd, workerd}. `child.kill()`
// reaches the first of those and nothing else, so the grandchildren survive holding the stdio pipes
// this process is still reading — and `node --test` will not exit while a pipe is open. Spawning
// DETACHED makes the child a process-group leader, and `process.kill(-pid)` then signals the whole
// group.
//
// It cost fifteen minutes of a CI runner to find, and the shape of the failure is why: every test
// PASSED, and the job then sat at 100% for the full timeout with an empty log. macOS happens to
// tear the tree down anyway, so it reproduces only on Linux. The runner's own cleanup named them —
// "Terminate orphan process: (workerd)", twice per wrangler.
function stop(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* group already gone */ }
  try { child.kill("SIGTERM"); } catch { /* ditto */ }
}

before(async () => {
  dev = spawn("npx", ["--yes", "wrangler@4.127.1", "dev", "--local", "--port", String(PORT), "--inspector-port", "0"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  dev.stdout.on("data", () => {});
  dev.stderr.on("data", () => {});
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) { await r.text(); break; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("wrangler dev did not come up within 90 s");
    await new Promise((r) => setTimeout(r, 500));
  }
  // Seed the emulated KV so the happy path has something to render. Written through the same
  // Worker binding the deployed one reads.
  const seed = {
    v: 1,
    generatedAt: new Date().toISOString().slice(0, 19) + "+08:00",
    meta: { weekLabel: "Test week", weekStart: "2000-01-01", weekEnd: "2099-12-31" },
    // The day-level fields are seeded with their own distinctive values because the week screen
    // publishes them, and "no user data without auth" has to cover what was added last rather
    // than only what was there when the assertion was written.
    days: [{ date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), dow: "Today",
             tag: "ZZTAGZZ", bed: { plan: "22:15", kind: "ZZKINDZZ", text: "ZZBEDZZ" },
             sessions: [{ kind: "Run · test", title: "ZZTITLEZZ", status: "planned", sport: "run",
                          place: "ZZPLACEZZ", leaveBy: "2099-01-01T05:55", oneRule: "ZZRULEZZ" }] }],
  };
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(`${ROOT}/dist`, { recursive: true });
  writeFileSync(`${ROOT}/dist/kv-seed.json`, JSON.stringify(seed));
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["--yes", "wrangler@4.127.1", "kv", "key", "put", "week:current",
    "--path", `${ROOT}/dist/kv-seed.json`, "--binding", "WEEK", "--local"],
    { cwd: ROOT, stdio: "ignore" });
});

after(() => { stop(dev); });

const post = (initData) => fetch(`${BASE}/s`, {
  method: "POST", body: initData,
  headers: { "Content-Type": "text/plain;charset=UTF-8" }, redirect: "manual",
});

async function assertDenied(res, what) {
  const body = await res.text();
  assert.equal(res.status, 401, `${what}: expected 401`);
  assert.equal(body.length, 0, `${what}: expected an EMPTY body, got ${body.length} bytes`);
  assert.equal(res.headers.get("content-type"), null, `${what}: a denial must not declare a content type`);
}

// ── the plan's four cases ──────────────────────────────────────────────────────────────────

// 🔴 THE DEEP LINK CROSSES THE AUTHENTICATION BOUNDARY WITH THE WEEK. The page prefers this copy
// to the one in the URL, so a response that drops it silently returns the reader to `today` --
// which is exactly what the week button did before 2026-09-02, and it looked like a working app.
test("the response carries the signed start_param back to the page", async () => {
  const res = await post(mintInitData({ userId: ALLOWED_ID, extra: { start_param: "week" } }));
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.ok, true);
  assert.equal(view.startParam, "week");
});

test("a launch with no deep link answers an empty start_param, not a missing key", async () => {
  const view = await (await post(mintInitData({ userId: ALLOWED_ID }))).json();
  assert.equal(view.startParam, "");
});

test("valid initData for Calvin -> 200 and the week, as JSON", async () => {
  const res = await post(mintInitData({ userId: ALLOWED_ID }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const view = await res.json();
  assert.equal(view.ok, true);
  assert.equal(view.now.title, "ZZTITLEZZ", "the week must cross the boundary only here");
  assert.equal(view.now.place, "ZZPLACEZZ");
  // The second screen's data comes through the SAME authenticated response. There is no second
  // request for it, so there is no second thing to get the access control right on.
  assert.equal(view.week.days[0].tag, "ZZTAGZZ");
  assert.equal(view.week.days[0].bed.text, "ZZBEDZZ");
  assert.equal(view.week.days[0].sessions[0].sport, "run");
});

test("valid signature, DIFFERENT user.id -> 401, no content", async () => {
  // The case most likely to be skipped, and the only one that proves this is an access control
  // rather than a signature check. This initData is genuinely, correctly signed by the bot.
  await assertDenied(await post(mintInitData({ userId: 999999999 })), "stranger");
});

test("tampered hash -> 401, no content", async () => {
  await assertDenied(await post(mintInitData({ corruptHash: true })), "tampered");
});

test("auth_date two hours old -> 401, no content", async () => {
  const authDate = Math.floor(Date.now() / 1000) - 7200;
  await assertDenied(await post(mintInitData({ authDate })), "replayed");
});

// ── everything else the surface exposes ────────────────────────────────────────────────────

test("no initData at all -> 401, no content", async () => {
  await assertDenied(await post(""), "empty");
});

test("initData signed with the wrong bot token -> 401, no content", async () => {
  await assertDenied(await post(mintInitData({ botToken: "999:not-the-bot" })), "wrong-bot");
});

// THE PROPERTY THAT ACTUALLY MATTERS. The page is served to anyone -- it has to be, because
// Telegram puts the launch in a URL fragment no server ever sees -- so what must be true is that
// it carries NONE OF THE WEEK. Asserted against distinctive values seeded into KV, so a pass is a
// measurement rather than a guess at what the plan's words look like.
test("GET / carries the renderer but none of the week's content", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  assert.equal(res.status, 200);
  for (const secret of ["ZZTITLEZZ", "ZZPLACEZZ", "ZZRULEZZ", "ZZTAGZZ", "ZZKINDZZ", "ZZBEDZZ", "2099-01-01T05:55"]) {
    assert.doesNotMatch(body, new RegExp(secret), `the unauthenticated page leaked ${secret}`);
  }
  assert.doesNotMatch(body, /week:current/, "nor the name of where the week lives");
  assert.match(body, /<title>Today<\/title>/, "but it IS the app, not a stub");
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
  assert.doesNotMatch(res.headers.get("content-security-policy") ?? "", /unsafe-inline/);
});

// The regression control for the bug that made the page render blank: the page and the data it
// fetches must be ONE document, so there is exactly one nonce in play.
test("the page's CSP nonce matches the one stamped on its own inline script and style", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  const headerNonce = (res.headers.get("content-security-policy") ?? "").match(/nonce-([A-Za-z0-9]+)/)?.[1];
  const bodyNonces = [...new Set([...body.matchAll(/nonce="([A-Za-z0-9]+)"/g)].map((m) => m[1]))];
  assert.ok(headerNonce, "the response must carry a nonce");
  assert.deepEqual(bodyNonces, [headerNonce], "every inline block must carry the header's nonce, and only it");
  // The CALL form, not the words. A bare /document\.write/ matches the comment in app.html that
  // explains why this must never come back -- an assertion that greps a whole file will happily
  // fire on its own documentation.
  assert.doesNotMatch(body, /document\.write\s*\(/, "a second document would get a second nonce and render blank");
  assert.doesNotMatch(body, /document\.open\s*\(/, "same reason");
});

// ── the theme, asserted against the SERVED document ────────────────────────────────────────
//
// This page is the donor: weekly-training-plan's design-system reference sends every plan
// artifact here to lift the palette, so a state dropped in a re-lift is a state dropped in next
// week's artifact too. Nothing else looks at this file -- mac-upkeep's design_token_drift task
// diffs the Hermes box's tokens.css against the live design.md and never opens src/app.html --
// which is why these are commands rather than a comment.
test("the served page carries all three theme states, with color-scheme pinned on both stamps", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();

  // Block 1 is the only one that paints for a reader who has never chosen, and it hands the
  // scheme to the OS because nothing has overruled it.
  assert.match(body, /:root\{[^}]*color-scheme:\s*light dark/, "block 1 must declare both schemes");
  assert.match(body, /@media \(prefers-color-scheme: dark\)\{\s*:root:not\(\[data-theme=light\]\)/,
    "block 2 must be the media query, guarded against the light stamp");

  // The two stamped states overrule the OS, so each has to TELL the UA which it is. Unpinned,
  // forcing one on a device set to the other leaves the scrollbars and form controls behind.
  assert.match(body, /:root\[data-theme=dark\]\{[^}]*color-scheme:\s*dark/,
    "the dark stamp must pin color-scheme:dark");
  assert.match(body, /:root\[data-theme=light\]\{[^}]*color-scheme:\s*light/,
    "the light stamp must pin color-scheme:light");

  // ...and the light stamp must carry that AND NOTHING ELSE. A fourth copy of the light token
  // list would be a copy with no runtime reason to exist: block 1 already supplies those values.
  const lightStamp = body.match(/:root\[data-theme=light\]\{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(lightStamp, /--/, "the light stamp must declare no tokens of its own");
});

test("the theme control offers three states and can get back to the un-stamped one", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();

  // Three, not two. A two-state toggle stamps on its first press and can never return the
  // reader to "follow the system" for the life of that browser.
  for (const v of ["system", "light", "dark"]) {
    assert.match(body, new RegExp(`<input type="radio" name="theme" id="theme-${v}" value="${v}"`),
      `the control must offer ${v}`);
  }
  // The un-stamped state is the ABSENCE of the attribute, so removing it is the whole of it.
  assert.match(body, /removeAttribute\("data-theme"\)/,
    "choosing system must remove the attribute rather than stamp a third value");

  // The document is served un-stamped. Anything else would make block 1 unreachable.
  assert.match(body, /<html lang="en">/, "the served document must stamp no theme of its own");

  // Every option is nameable. Two are a mark alone -- the mark set ships a sun and a moon and
  // nothing meaning "follow the system", which is why that one is a word instead.
  for (const name of ["System", "Light", "Dark"]) {
    assert.match(body, new RegExp(`>${name}</`), `${name} must be readable to a screen reader`);
  }
  assert.doesNotMatch(body, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    "a state the mark set has no mark for is drawn as a word, never an emoji");
});

// Telegram's own design guideline is that a Mini App "should deliver a seamless experience by
// monitoring the dynamic theme-based colors provided by the API and using them accordingly".
// This page carries its own design system, so it satisfies that OUTWARD -- it tells Telegram what
// it is painted rather than repainting itself in Telegram's colours. Without this the reader can
// now choose light while Telegram is dark and sit under a mismatched header.
test("the page tells Telegram what it is painted, reading the value from the token", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();

  assert.match(body, /web_app_set_background_color/, "the ground must be sent to the client");
  assert.match(body, /web_app_set_header_color/, "and so must the header, or the seam is half done");

  // Read from --background, never written as a literal: it is the one thing that already says
  // what the resolved ground is in all three states, and a hex here would be wrong in two of them.
  assert.match(body, /getPropertyValue\("--background"\)/,
    "the colour must be read out of the token");
  const sync = body.match(/function syncChrome\(\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? "";
  assert.ok(sync.length > 0, "syncChrome must exist");
  assert.doesNotMatch(sync, /#[0-9a-fA-F]{6}/, "no literal hex may appear in the colour sync");
});

test("a theme swap snaps rather than ramping the chips across the old palette", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  // The chip's 300ms ramp is its hover and press affordance. A theme change moves every token at
  // once, so without suppression the ground flips instantly while the chips ease -- an
  // acknowledgement of the press arriving after the press.
  // BOTH WEARERS OF THE SURFACE, which is the half that was missed the first time. The navigation
  // chip shares the quiet box, the hover and the press with the theme options -- so it also
  // inherits the 300ms ramp, and suppressing the ramp on only one of them leaves the other easing
  // across the OLD palette on the NEW ground. Caught in a browser, not by this suite, because the
  // assertion below named one selector.
  assert.match(body, /:root\[data-swapping\] \.theme label,:root\[data-swapping\] \.chip\{transition:none\}/,
    "the swap must suppress the ramp on EVERY control wearing the chip surface");
  assert.match(body, /setAttribute\("data-swapping", ""\)[\s\S]*offsetWidth[\s\S]*removeAttribute\("data-swapping"\)/,
    "and must force a reflow between setting and clearing it, or nothing is suppressed");
});

// 🔴 THE REGRESSION CONTROL FOR A BUG THAT SHIPPED. Telegram's back arrow rendered on an iPhone
// and pressing it did nothing: the outbound `web_app_setup_back_button` was correct, and the page
// never received `back_button_pressed`. Telegram delivers an event by CALLING a function on the
// page BY NAME, and the name differs per client — so installing one of the three is installing
// none of them for two clients out of three.
test("a back-button press can reach the app on every client that sends one", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();

  for (const path of [
    "window.Telegram.WebView",              // iOS and Android
    "window.TelegramGameProxy",             // Desktop
    "TelegramGameProxy_receiveEvent",       // Windows Phone
  ]) {
    assert.match(body, new RegExp(path.replace(/[.$]/g, "\\$&")),
      `the receiver must be installed at ${path}, or that client's arrow is inert`);
  }

  // AND NEVER BEHIND A "DO NOT CLOBBER" GUARD, which is the exact shape of the shipped bug: the
  // client puts its own object at that path before this script runs, so a check for an existing
  // handler skips our own assignment entirely and the arrow goes dead.
  assert.doesNotMatch(body, /if\s*\(\s*!\s*window\.Telegram\.WebView\.receiveEvent\s*\)/,
    "installing the receiver conditionally is how it was silently skipped on iOS");
  assert.match(body, /installReceiver/, "the receiver must chain what was there, not defer to it");
});

// The week is long and a reader who opens it must be able to leave it, whatever the client does
// with the header. This was version-gated once, and on the one device it mattered the gate was
// open, the arrow was dead, and the screen was a dead end.
test("the week screen always draws its own way back, and a spent day opens", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  assert.match(body, /navChip\("Today"/, "there must be an in-page way back to Today");
  assert.match(body, /el\("details"\)/, "a spent day is a disclosure the reader can open");
  assert.match(body, /el\("summary"\)/);
  // The disclosure mark is the closed set's own arrow, turned -- never a chevron from elsewhere.
  assert.match(body, /details\[open\] > summary \.disc\{transform:rotate\(90deg\)\}/);
});

// THE REGRESSION CONTROL FOR A COSMETIC BUG THAT SHIPPED, and it is a source-text assertion for
// the same reason the two above are: nothing in this suite renders the DOM, so the only thing it
// can see is the stylesheet it served.
//
// `renderNav` sets `navEl.hidden = true` on every screen with nowhere to navigate. That was
// correct and did nothing: `hidden` is a UA-stylesheet rule at the lowest specificity there is,
// and `.navbar` sets `display:flex` on a CLASS, which beats it. So the refusal screen drew an
// empty 9-pixel glass sliver with no tabs in it -- shipped in #27, live on two routes, and
// invisible to 178 passing tests because the attribute WAS being set.
//
// The rule below is the whole fix, and it looks redundant with the attribute, which is exactly why
// it needs a test standing on it. Deleting it does not break the markup; it restores the bug.
test("the navigation can actually be hidden, not merely marked hidden", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  assert.match(body, /\.navbar\[hidden\]\{display:none\}/,
    "a class-level display beats the hidden attribute, so the attribute needs a rule of its own");

  // THE CONDITION, NOT JUST THE ASSIGNMENT -- and the difference was measured rather than assumed.
  // An earlier version of this test asserted only that `navEl.hidden = true` appeared somewhere,
  // and mutating the guard to `if (false)` -- so the bar is NEVER hidden -- left the whole suite
  // green, because the dead assignment was still in the source. Pinning the condition is what
  // makes the rule below testable at all.
  //
  // It is also the line between two rules that disagree. Apple: "Don't disable or hide tab bar
  // buttons, even when their content is unavailable... If a section is empty, explain why." This
  // page: a control that opens onto emptiness lies about having something behind it. A published
  // plan with no days is an EMPTY section and keeps its tabs; a refusal has no sections at all and
  // gets no bar. `ok` is what separates them, and a future change that reaches for `hasWeek()`
  // here instead would silently take Apple's case away.
  assert.match(body, /if \(!view \|\| !view\.ok\) \{ navEl\.hidden = true;/,
    "only a refusal hides the bar -- an empty week keeps it, and explains itself");
});

// The scroll edge effect is the ONE gradient on a page whose design system has none, so it reads
// as a stray decoration and is exactly the kind of rule a later pass deletes for consistency.
// Apple's guidance is that it is not decorative -- it is what keeps a floating control distinct
// from the content scrolling behind it -- and the reason it exists here was measured on a phone:
// the bar was eating digits out of number-dense prose. Neither of those facts is visible from the
// CSS, so the rule gets an assertion standing on it.
//
// A source-text assertion is the ONLY form available: nothing in this suite renders the DOM, and
// `get styles` cannot address a pseudo-element even in a browser.
test("the bar keeps its scroll edge effect, which is not decoration", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  // PIN THE DECLARATION, NOT THE SELECTOR. `.navbar::before` appears TWICE -- once for the effect
  // and once in the forced-colours block that removes it -- so a bare selector match is satisfied
  // by the suppression rule alone. Measured: renaming the real rule and leaving the forced-colours
  // one kept this test GREEN with the effect gone. Match the opening declarations instead.
  assert.match(body, /\.navbar::before\{\s*content:""; position:fixed/,
    "the effect is attached to the bar, so it hides with it");
  assert.match(body, /linear-gradient\(to top,/, "content dissolves upward into the page");
  // BOTH STOPS ARE THE GROUND. Apple: scroll edge effects "don't block or darken like overlays".
  // A literal colour here would be a scrim -- the decorative version the guidance rules out, and
  // wrong in at least one theme besides.
  assert.doesNotMatch(body.slice(body.indexOf(".navbar::before{"), body.indexOf(".navbar::before{") + 400),
    /#[0-9a-fA-F]{6}|rgba?\(/, "the effect must be built from --background, never a literal scrim");
});

test("the header clears the status bar in BOTH of the launch states, not just the settled one", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  // Measured on the phone: env(safe-area-inset-top) reports 0 in this app in both states, while
  // env(safe-area-inset-bottom) reports 34 once settled. So --sa-top is not belt-and-braces, it is
  // the only source that knows about the top edge, and env() is kept because it is the correct one
  // wherever it does work. max() of the two SOURCES, then add the page's own margin -- additive,
  // because clearing the hardware and having a margin are different jobs.
  assert.match(body, /padding-top:calc\(max\(env\(safe-area-inset-top\), var\(--sa-top, 0px\)\) \+ 1\.25rem\);/,
    "the top padding takes the inset from whichever source knows it, and adds the page's margin");
  // THE CONDITION, NOT THE CALL. A syncTopInset that always wrote 0 would leave every assertion
  // about its existence green while the header spent every launch under the status bar.
  assert.match(body, /var gap = sh - window\.innerHeight;\s*if \(gap > 0\) learnedTopInset = gap;/,
    "the inset is learned from the settled viewport rather than written as a constant");
  assert.match(body, /docEl\.style\.setProperty\("--sa-top", \(gap > 0 \? 0 : \(learnedTopInset \|\| 59\)\) \+ "px"\);/,
    "the inset applies only while the viewport is the full screen, which is when the bar overlaps");
  // `screen` is this file's own variable for which screen is showing and shadows the global; the
  // diagnostic that found all of this reported screenH=undefined for precisely that reason.
  assert.match(body, /var sh = \(window\.screen && window\.screen\.height\) \|\| 0;/,
    "the global is reached through window, because `screen` is taken in this scope");
  // The settle IS a resize, and it is the whole reason this listener exists.
  assert.match(body, /window\.addEventListener\("resize", syncTopInset\);/,
    "the settle arrives as a resize and has to be caught");
});

test("no diagnostic survives into the served document", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  // Two temporary instruments were shipped to production to measure the inset -- a striped ruler
  // and a numeric readout -- because no browser available here could produce those numbers. Both
  // were meant to be deleted by the change that read them. This is the check that they were.
  assert.doesNotMatch(body, /\.ruler\{|\.readout\{|satprobe|data-installed/,
    "a measuring instrument was left in the page that a reader will see");
});

test("GET /s is refused -- the app is not reachable without a POSTed launch", async () => {
  await assertDenied(await fetch(`${BASE}/s`), "GET /s");
});

test("a launch with surrounding whitespace still validates", async () => {
  // A transport that appends a newline must not read as a forged launch.
  const res = await post("\n" + mintInitData({ userId: ALLOWED_ID }) + "\n");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("there is no OTHER endpoint to find", async () => {
  for (const p of ["/payload.json", "/week", "/api/week", "/app.html", "/src/app.html", "/.dev.vars"]) {
    const res = await fetch(`${BASE}${p}`);
    const body = await res.text();
    assert.equal(res.status, 404, `${p} should 404`);
    assert.equal(body.length, 0, `${p} should return nothing`);
  }
});

// ── fail-closed: a Worker missing its access-control secret must refuse EVERYONE ───────────
//
// This is the failure that makes an app public by accident: someone deploys, forgets a
// `wrangler secret put`, and an unset allowlist reads as "no restriction". Proving it needs a
// launch that is otherwise perfectly valid -- a bad one would 401 for the wrong reason and the
// test would pass while proving nothing.
test("with ALLOWED_USER_ID unset, a VALID launch for Calvin is still refused", async () => {
  const port = PORT + 2;
  const child = spawn("npx", ["--yes", "wrangler@4.127.1", "dev", "--local", "--port", String(port),
    "--inspector-port", "0", "--var", "ALLOWED_USER_ID:"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        if (r.status === 200) { await r.text(); break; }
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("second wrangler dev did not come up");
      await new Promise((r) => setTimeout(r, 500));
    }
    // Sanity: the same launch is accepted by the correctly-configured server on PORT.
    const good = await post(mintInitData({ userId: ALLOWED_ID }));
    assert.equal(good.status, 200, "control: this launch must be accepted when the id IS configured");
    await good.text();

    const res = await fetch(`http://127.0.0.1:${port}/s`, {
      method: "POST", body: mintInitData({ userId: ALLOWED_ID }),
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    });
    await assertDenied(res, "unconfigured worker");
  } finally {
    stop(child);
  }
});
