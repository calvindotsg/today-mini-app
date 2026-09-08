// The browser / home-screen auth suite, against the REAL Worker in the REAL runtime.
//
// The unit suites prove the two algorithms. They do NOT prove the Worker wires them in: that
// /web/s actually reads the cookie, that the email is re-checked on every request rather than only
// at sign-in, that a refusal ships an EMPTY body, or that /web/ answers 200 in every auth state.
// An access.js that returned null unconditionally passes every unit test in this repository.
//
// ⚠️ PORTS. The main suite owns 8799 and 8801 (PORT and PORT+2). A dev server left on either does
// not collide loudly — the fail-closed test finds a correctly-configured server and reads 200 where
// it wants 401, which looks like a fail-open bug in the Worker. This file takes 8803 and 8805.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessKeypair, jwksBody, mintAccessJwt, mintSessionCookie,
  FAKE_ACCESS_AUD, FAKE_ALLOWED_EMAIL, FAKE_TEAM_DOMAIN,
} from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8803;
const BASE = `http://127.0.0.1:${PORT}`;
const COOKIE = "__Host-today_session";

let dev, jwks, key, certsUrl;

// See worker.http.test.mjs: `npx` is a wrapper and signalling it does not signal what it started.
function stop(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { /* group already gone */ }
  try { child.kill("SIGTERM"); } catch { /* ditto */ }
}

async function waitUp(port, deadlineMs = 90_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) { await r.text(); return; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`wrangler dev on ${port} did not come up`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

before(async () => {
  key = await accessKeypair("kid-http");
  // Cloudflare's certs endpoint, served locally. The Worker is pointed at it with a --var, which
  // is the only reason this can run without a real Access application.
  jwks = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(jwksBody(key));
  });
  await new Promise((r) => jwks.listen(0, "127.0.0.1", r));
  certsUrl = `http://127.0.0.1:${jwks.address().port}/cdn-cgi/access/certs`;

  dev = spawn("npx", ["--yes", "wrangler@4.127.1", "dev", "--local", "--port", String(PORT),
    "--inspector-port", "0", "--var", `ACCESS_CERTS_URL:${certsUrl}`],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  dev.stdout.on("data", () => {});
  dev.stderr.on("data", () => {});
  await waitUp(PORT);

  // Distinctive values, so "no plan data without auth" is asserted against what is actually
  // published rather than against a guess at what the real content looks like.
  const seed = {
    v: 1,
    generatedAt: new Date().toISOString().slice(0, 19) + "+08:00",
    meta: { weekLabel: "Test week", weekStart: "2000-01-01", weekEnd: "2099-12-31" },
    days: [{ date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), dow: "Today",
             tag: "ZZTAGZZ", bed: { plan: "22:15", kind: "ZZKINDZZ", text: "ZZBEDZZ" },
             sessions: [{ kind: "Run · test", title: "ZZTITLEZZ", status: "planned", sport: "run",
                          place: "ZZPLACEZZ", leaveBy: "2099-01-01T05:55", oneRule: "ZZRULEZZ" }] }],
  };
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(`${ROOT}/dist`, { recursive: true });
  writeFileSync(`${ROOT}/dist/kv-seed-web.json`, JSON.stringify(seed));
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["--yes", "wrangler@4.127.1", "kv", "key", "put", "week:current",
    "--path", `${ROOT}/dist/kv-seed-web.json`, "--binding", "WEEK", "--local"],
    { cwd: ROOT, stdio: "ignore" });
});

after(() => { stop(dev); jwks?.close(); });

async function assertDenied(res, what) {
  const body = await res.text();
  assert.equal(res.status, 401, `${what} must be refused`);
  assert.equal(body.length, 0, `${what} must ship a ZERO-BYTE body, not the page`);
}

const signin = (token) => fetch(`${BASE}/web/signin`, {
  redirect: "manual",
  headers: token === null ? {} : { "Cf-Access-Jwt-Assertion": token },
});

const weekWith = (cookie) => fetch(`${BASE}/web/s`, {
  method: "POST",
  headers: cookie === null ? {} : { cookie: `${COOKIE}=${cookie}` },
});

// ── the positive controls, first, because a Worker that refuses everything passes the rest ──
test("a genuine Access token mints a session and redirects into the app", async () => {
  const res = await signin(await mintAccessJwt(key));
  assert.equal(res.status, 302, "a valid token must be ACCEPTED");
  assert.equal(res.headers.get("location"), "/web/",
    "a literal target — Access appends its own redirect_url and honouring it is an open redirect");
  const set = res.headers.getSetCookie().find((c) => c.startsWith(COOKIE));
  assert.ok(set, "a session cookie must be set");
  // 🔴 Max-Age keeps this clear of WebKit 272325 in a home-screen app; the rest are the basics.
  assert.match(set, /Max-Age=\d+/);
  assert.match(set, /Secure/);
  assert.match(set, /HttpOnly/);
  assert.doesNotMatch(set, /Domain=/);
});

test("that session then reads the week", async () => {
  const res = await signin(await mintAccessJwt(key));
  const cookie = res.headers.getSetCookie()
    .find((c) => c.startsWith(COOKIE)).split(";")[0].slice(COOKIE.length + 1);
  const week = await weekWith(cookie);
  assert.equal(week.status, 200, "a freshly minted session must be able to read the plan");
  const body = await week.text();
  assert.match(body, /ZZTITLEZZ/, "and it must be the seeded week, not an empty view");
});

// ── the gate that decides WHOSE session it is ───────────────────────────────────────────────
test("🔴 a validly signed cookie for the WRONG email is refused by /web/s", async () => {
  // Signed with the live secret, unexpired, structurally perfect — it differs only in the address.
  // Without the per-request email check the cookie IS the authorisation, and changing
  // ALLOWED_EMAIL or deleting the Access policy would revoke nothing for thirty days.
  const cookie = await mintSessionCookie({ email: "someone-else@example.com" });
  await assertDenied(await weekWith(cookie), "a session for another address");
});

test("a valid Access token for the WRONG email mints nothing", async () => {
  const res = await signin(await mintAccessJwt(key, { email: "someone-else@example.com" }));
  await assertDenied(res, "a token for another address");
  assert.equal(res.headers.getSetCookie().length, 0, "and it must not set a cookie on the way out");
});

test("a token for ANOTHER Access application on the same account mints nothing", async () => {
  const res = await signin(await mintAccessJwt(key, { aud: "f".repeat(64) }));
  await assertDenied(res, "a sibling application's token");
});

// ── the ordinary refusals, each shipping nothing ────────────────────────────────────────────
test("no token, a forged token and an expired one are all refused with an empty body", async () => {
  await assertDenied(await signin(null), "a request with no assertion header");
  await assertDenied(await signin("not-a-jwt"), "a malformed assertion");
  await assertDenied(await signin(await mintAccessJwt(key, { alg: "none" })), "alg:none");
  const nowSec = Math.floor(Date.now() / 1000);
  await assertDenied(await signin(await mintAccessJwt(key, { expSec: nowSec - 60 })), "an expired token");
});

test("no cookie, a forged cookie and an expired one are all refused with an empty body", async () => {
  await assertDenied(await weekWith(null), "a request with no cookie");
  await assertDenied(await weekWith("garbage"), "a malformed cookie");
  await assertDenied(await weekWith(await mintSessionCookie({ corruptMac: true })), "a forged cookie");
  await assertDenied(await weekWith(await mintSessionCookie({ ttlMs: -1000 })), "an expired cookie");
  await assertDenied(await weekWith(await mintSessionCookie({ secret: "a-completely-different-signing-key!!" })),
    "a cookie signed with another secret");
});

test("/web/s answers only POST", async () => {
  await assertDenied(await fetch(`${BASE}/web/s`), "a GET to the data path");
});

// ── the exact-path rule ─────────────────────────────────────────────────────────────────────
test("the Access path is matched EXACTLY, so no sibling path reaches the mint", async () => {
  // Cloudflare does not strip Cf- request headers on paths no application covers, so these arrive
  // carrying a client-supplied assertion. They must not be treated as /web/signin.
  const token = await mintAccessJwt(key);
  for (const p of ["/web/signin/", "/web/signin/x", "/web/signinx"]) {
    const res = await fetch(`${BASE}${p}`, { headers: { "Cf-Access-Jwt-Assertion": token }, redirect: "manual" });
    const body = await res.text();
    assert.equal(res.status, 404, `${p} must not be the sign-in path`);
    assert.equal(body.length, 0, `${p} must ship nothing`);
  }
});

// ── the start_url contract, which is what keeps a home-screen app recoverable ────────────────
test("🔴 GET /web/ answers 200 in EVERY auth state and never redirects", async () => {
  // A standalone app has no address bar, no reload and no back. If this redirected to /web/signin
  // the launch itself would be handed to Access and then to another origin, before any gesture --
  // and the reader would be looking at a chrome-less error with no way out.
  for (const [what, headers] of [
    ["no cookie", {}],
    ["a forged cookie", { cookie: `${COOKIE}=garbage` }],
    ["an expired cookie", { cookie: `${COOKIE}=${await mintSessionCookie({ ttlMs: -1000 })}` }],
  ]) {
    const res = await fetch(`${BASE}/web/`, { headers, redirect: "manual" });
    assert.equal(res.status, 200, `/web/ with ${what} must still serve the app`);
    const body = await res.text();
    assert.ok(body.length > 1000, `/web/ with ${what} must serve the real document`);
    assert.doesNotMatch(body, /ZZTITLEZZ|ZZPLACEZZ|ZZRULEZZ|ZZBEDZZ|ZZTAGZZ/,
      `/web/ with ${what} must carry NO plan data — the week only crosses at /web/s`);
  }
});

test("/web redirects to /web/ so a shared or typed link reaches the app", async () => {
  const res = await fetch(`${BASE}/web`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/web/");
});

// ── one document, two routes ────────────────────────────────────────────────────────────────
test("🔴 / and /web/ serve a BYTE-IDENTICAL document", async () => {
  // The mode is derived on the client from location.pathname, and it has to stay that way. A second
  // per-request template token would break ci.yml's and drift.yml's deploy proof, which normalise
  // __NONCE__ and nothing else. This assertion also makes the two documents structurally incapable
  // of drifting -- the same argument that makes the two screens share renderSlot/renderBed.
  const norm = (s) => s.replace(/nonce="[^"]*"/g, 'nonce="N"');
  const a = norm(await (await fetch(`${BASE}/`)).text());
  const b = norm(await (await fetch(`${BASE}/web/`)).text());
  assert.equal(a, b, "the two routes must serve the same bytes once the nonce is normalised");
});

test("🔴 the deploy digest CI computes still matches the document this Worker serves", async () => {
  // ci.yml:185 and drift.yml:51 hash `sed 's/__NONCE__/N/g' src/app.html` and compare it against
  // the live page normalised on `nonce="..."` alone. Any occurrence of that placeholder OUTSIDE a
  // nonce attribute -- in a COMMENT, say -- makes the two disagree for ever: every deploy reports
  // red while shipping fine, and drift.yml opens a Deploy-drift issue on every push to main.
  // drift.yml is the replacement for trap 2's dead alarm, so that is the whole live shipping alarm
  // gone, and the failure reads as a deploy fault rather than a source one.
  //
  // This exists because it very nearly happened: a comment EXPLAINING the placeholder rule was
  // written containing the placeholder's literal name, and the Worker substituted it. Caught by
  // the byte-identical test below and turned into this, because CI would only have found it after
  // a deploy had already gone red.
  //
  // ⚠️ AND THE EXISTING NONCE TEST DOES NOT COVER THIS, so do not delete either as a duplicate.
  // worker.http.test.mjs:169-174 collects `nonce="..."` occurrences and asserts they all equal the
  // header's. A substituted value sitting loose inside a COMMENT matches that pattern nowhere at
  // all, so it passes there in silence. The two guards look alike and catch different things.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(`${ROOT}/src/app.html`, "utf8").replace(/__NONCE__/g, "N");
  const live = (await (await fetch(`${BASE}/`)).text()).replace(/nonce="[^"]*"/g, 'nonce="N"');
  assert.equal(live, src, "the nonce placeholder must appear only inside nonce attributes");
});

test("the web document declares its manifest and icons in the policy, and frames nowhere", async () => {
  const res = await fetch(`${BASE}/web/`);
  await res.text();
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /manifest-src 'self'/, "a blocked manifest installs a Safari bookmark, silently");
  assert.match(csp, /img-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/,
    "a cookie-authenticated page must not inherit the Mini App's frame parent");

  const tg = await fetch(`${BASE}/`);
  await tg.text();
  const tgCsp = tg.headers.get("content-security-policy");
  assert.match(tgCsp, /frame-ancestors https:\/\/web\.telegram\.org/, "the Telegram document is unchanged");
  assert.doesNotMatch(tgCsp, /img-src|manifest-src/, "and is not widened by this work");
});

// ── the installable bits ────────────────────────────────────────────────────────────────────
test("the manifest is public, cacheable, and scoped so iOS keeps links inside the app", async () => {
  const res = await fetch(`${BASE}/web/app.webmanifest`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/manifest\+json/);
  // NOT no-store: iOS fetches this when the Share sheet opens, and a racing fetch installs a
  // bookmark instead of an app -- which fails silently, because the icon appears either way.
  assert.match(res.headers.get("cache-control"), /max-age=\d+/);
  const m = await res.json();
  assert.equal(m.scope, "/web/", "an absent scope makes iOS open every link in Safari");
  assert.equal(m.start_url, "/web/");
  assert.equal(m.display, "standalone");
  assert.equal(m.short_name.length <= 12, true, "iOS truncates the home-screen label around 12 chars");
  assert.ok(m.icons.some((i) => i.sizes === "512x512"));
});

test("🔴 the manifest's splash colour still equals the palette token it was copied from", async () => {
  // A manifest cannot read a CSS custom property, so this is the one place a palette value is
  // restated outside app.html's three blocks. Without this assertion the two drift silently the
  // day the ground changes.
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(`${ROOT}/src/app.html`, "utf8");
  // The FIRST --background in the file is block 1's, the bare :root that paints the un-stamped
  // state. Matched directly rather than sliced between landmarks, because the landmarks move.
  const token = app.match(/--background:\s*(#[0-9a-fA-F]{6})/)?.[1];
  assert.ok(token, "block 1 must declare --background");
  const m = await (await fetch(`${BASE}/web/app.webmanifest`)).json();
  assert.equal(m.background_color.toLowerCase(), token.toLowerCase());
  assert.equal(m.theme_color, undefined,
    "theme_color is deliberately absent: a literal would be wrong in two of the three theme states");
});

test("the icons are served as opaque PNGs at the sizes iOS and the manifest ask for", async () => {
  for (const [path, size] of [["/web/icon-180.png", 180], ["/web/icon-192.png", 192], ["/web/icon-512.png", 512]]) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, `${path} must be served`);
    assert.equal(res.headers.get("content-type"), "image/png");
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...buf.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${path} must be a real PNG`);
    const view = new DataView(buf.buffer);
    assert.equal(view.getUint32(16), size, `${path} must be ${size} wide`);
    assert.equal(view.getUint32(20), size, `${path} must be ${size} tall`);
    // 🔴 Colour type 2 = RGB with NO alpha. iOS ignores an alpha channel and paints transparent
    // pixels BLACK, which would erase this artwork's outline and the bar it peeks over.
    assert.equal(buf[25], 2, `${path} must carry no alpha channel`);
  }
  const missing = await fetch(`${BASE}/web/icon-999.png`);
  assert.equal(missing.status, 404);
});

// ── fail closed ─────────────────────────────────────────────────────────────────────────────
//
// The failure this guards is someone deploying without `wrangler secret put`. An empty
// SESSION_SECRET used as an HMAC key would be forgeable by anyone reading this public repository.
test("with SESSION_SECRET unset, a VALID Access token still mints nothing", async () => {
  const port = 8805;
  const child = spawn("npx", ["--yes", "wrangler@4.127.1", "dev", "--local", "--port", String(port),
    "--inspector-port", "0", "--var", `ACCESS_CERTS_URL:${certsUrl}`, "--var", "SESSION_SECRET:"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  try {
    await waitUp(port);
    const token = await mintAccessJwt(key);

    // Control: the SAME token is accepted by the correctly-configured server. Without this the
    // test could pass because the token was bad rather than because the Worker failed closed.
    const good = await signin(token);
    assert.equal(good.status, 302, "control: this token must be accepted when the secret IS set");

    const res = await fetch(`http://127.0.0.1:${port}/web/signin`, {
      headers: { "Cf-Access-Jwt-Assertion": token }, redirect: "manual",
    });
    await assertDenied(res, "an unconfigured worker");

    // ⚠️ AND THE TELEGRAM PATH IS UNTOUCHED BY THE MISSING SECRET. Folding the web secrets into
    // `configured` would make every clone whose .dev.vars predates them fail the Telegram happy
    // path with 401 !== 200 -- trap 1's exact misleading signature.
    const home = await fetch(`http://127.0.0.1:${port}/`);
    await home.text();
    assert.equal(home.status, 200, "a missing web secret must not take the Mini App down with it");
  } finally {
    stop(child);
  }
});
