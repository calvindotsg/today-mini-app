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
    days: [{ date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), dow: "Today",
             sessions: [{ kind: "Run · test", title: "ZZTITLEZZ", status: "planned",
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

test("valid initData for Calvin -> 200 and the week, as JSON", async () => {
  const res = await post(mintInitData({ userId: ALLOWED_ID }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const view = await res.json();
  assert.equal(view.ok, true);
  assert.equal(view.now.title, "ZZTITLEZZ", "the week must cross the boundary only here");
  assert.equal(view.now.place, "ZZPLACEZZ");
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
  for (const secret of ["ZZTITLEZZ", "ZZPLACEZZ", "ZZRULEZZ", "2099-01-01T05:55"]) {
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
  assert.match(body, /:root\[data-swapping\] \.theme label\{transition:none\}/,
    "the swap must suppress the chip ramp");
  assert.match(body, /setAttribute\("data-swapping", ""\)[\s\S]*offsetWidth[\s\S]*removeAttribute\("data-swapping"\)/,
    "and must force a reflow between setting and clearing it, or nothing is suppressed");
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
