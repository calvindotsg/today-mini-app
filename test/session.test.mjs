// The browser/PWA session cookie. Fixtures are minted with node's own HMAC in helpers.mjs rather
// than by calling session.js, for the reason initdata.test.mjs gives: a suite that builds its
// fixtures with the checker's own code agrees with it by construction.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COOKIE_NAME,
  SESSION_ABSOLUTE_MS,
  SESSION_TTL_MS,
  clearSessionCookieHeader,
  mintSession,
  readCookie,
  sessionCookieHeader,
  shouldRenew,
  verifySession,
} from "../src/session.js";
import { mintSessionCookie, FAKE_ALLOWED_EMAIL, FAKE_SESSION_SECRET } from "./helpers.mjs";

const secret = FAKE_SESSION_SECRET;
const v = (value, over = {}) => verifySession(value, { secret, ...over });

// ── the positive control, first ─────────────────────────────────────────────────────────────
test("a cookie minted by the Worker verifies, and carries the email back", async () => {
  const r = await v(await mintSession(FAKE_ALLOWED_EMAIL, { secret }));
  assert.equal(r.ok, true, "a valid cookie must be ACCEPTED — otherwise every test below is vacuous");
  assert.equal(r.email, FAKE_ALLOWED_EMAIL);
});

test("a cookie minted INDEPENDENTLY, the way the format specifies, also verifies", async () => {
  // If this disagrees with the line above, one of the two is wrong about the format — which is
  // the entire point of minting fixtures without the implementation.
  const r = await v(await mintSessionCookie({}));
  assert.equal(r.ok, true);
  assert.equal(r.email, FAKE_ALLOWED_EMAIL);
});

test("an email containing dots survives the round trip", async () => {
  // The delimiter is a dot and an address is full of them. A naive split() truncates the subject
  // and then verifies a different string than it parsed.
  const email = "a.b.c@sub.example.co.uk";
  const r = await v(await mintSession(email, { secret }));
  assert.equal(r.ok, true);
  assert.equal(r.email, email);
});

// ── forgery ─────────────────────────────────────────────────────────────────────────────────
test("a corrupted MAC is refused", async () => {
  const r = await v(await mintSessionCookie({ corruptMac: true }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-mac");
});

test("a cookie signed with a DIFFERENT secret is refused", async () => {
  const r = await v(await mintSessionCookie({ secret: "some-other-signing-key-also-long-enough!!" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-mac");
});

test("bytes may not shift between fields", async () => {
  // The MAC covers the raw delimited prefix. Signing a concatenation instead would make
  // (iat=1, exp=23) and (iat=12, exp=3) share a signature.
  const now = Date.now();
  const a = await mintSessionCookie({ fields: `v1.${now}.${now + 1000}.c29tZQ` });
  const shifted = a.replace(`v1.${now}.${now + 1000}.`, `v1.${now}0.${now + 100}.`);
  const r = await v(shifted);
  assert.equal(r.ok, false);
});

test("a truncated cookie is refused rather than padded into a valid one", async () => {
  const full = await mintSession(FAKE_ALLOWED_EMAIL, { secret });
  assert.equal((await v(full.split(".").slice(0, 4).join("."))).reason, "malformed");
  assert.equal((await v(full + ".extra")).reason, "malformed");
});

test("an unknown version tag is refused, so a format change is not read as a forgery", async () => {
  const r = await v(await mintSessionCookie({ version: "v2" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-version");
});

// ── the two lifetimes ───────────────────────────────────────────────────────────────────────
test("an expired cookie is refused", async () => {
  const r = await v(await mintSessionCookie({ ttlMs: -1000 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("🔴 the absolute ceiling is enforced ON READ, not only at mint", async () => {
  // A cookie whose exp is comfortably in the future but whose session began 91 days ago. Without
  // this check, sliding renewal is an unbounded session: a stolen cookie loaded once a month
  // never dies. Simulates a cookie minted by an older, more generous build.
  const now = Date.now();
  const value = await mintSessionCookie({ iatMs: now - (SESSION_ABSOLUTE_MS + 86_400_000), nowMs: now });
  const r = await v(value, { nowMs: now });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "past-absolute");
});

test("mint clamps exp to the ceiling rather than extending past it", async () => {
  const now = Date.now();
  const iatMs = now - (SESSION_ABSOLUTE_MS - 3_600_000); // an hour of ceiling left
  const value = await mintSession(FAKE_ALLOWED_EMAIL, { secret, nowMs: now, iatMs });
  const r = await v(value, { nowMs: now });
  assert.equal(r.ok, true);
  assert.ok(r.expMs <= iatMs + SESSION_ABSOLUTE_MS, "exp must never exceed first sign-in plus the ceiling");
});

test("renewal fires once a week of life has gone, and stops near the ceiling", async () => {
  const now = Date.now();
  const fresh = await verifySession(await mintSession(FAKE_ALLOWED_EMAIL, { secret, nowMs: now }), { secret, nowMs: now });
  assert.equal(shouldRenew(fresh, now), false, "a cookie minted this instant needs no renewal");

  const later = now + 8 * 24 * 3_600_000;
  assert.equal(shouldRenew(fresh, later), true, "a week on, it should be re-issued");

  const nearCeiling = await verifySession(
    await mintSession(FAKE_ALLOWED_EMAIL, { secret, nowMs: now, iatMs: now - (SESSION_ABSOLUTE_MS - 3_600_000) }),
    { secret, nowMs: now },
  );
  assert.equal(shouldRenew(nearCeiling, now), false, "near the ceiling it must be allowed to die");
});

test("a short or missing secret refuses everything rather than signing with nothing", async () => {
  const value = await mintSessionCookie({});
  assert.equal((await verifySession(value, { secret: "" })).reason, "no-secret");
  assert.equal((await verifySession(value, { secret: "too-short" })).reason, "no-secret");
  assert.equal((await verifySession(value, {})).reason, "no-secret");
});

// ── reading the cookie off the header ───────────────────────────────────────────────────────
test("a duplicated cookie name is refused rather than resolved by picking one", async () => {
  assert.equal(readCookie(`${COOKIE_NAME}=a; other=x`), "a");
  assert.equal(readCookie(`other=x; ${COOKIE_NAME}=a`), "a");
  assert.equal(readCookie(`${COOKIE_NAME}=a; ${COOKIE_NAME}=b`), null,
    "two candidates means trust neither, not take the first");
  assert.equal(readCookie("other=x"), null);
  assert.equal(readCookie(""), null);
  assert.equal(readCookie(null), null);
});

// ── the attributes, which are load-bearing on iOS ───────────────────────────────────────────
test("the cookie carries Max-Age, Secure, HttpOnly and no Domain", async () => {
  const h = sessionCookieHeader("x", Math.floor(SESSION_TTL_MS / 1000));
  assert.match(h, /^__Host-today_session=/, "the __Host- prefix forbids a Domain and pins Path=/");
  // 🔴 Max-Age is what keeps this clear of WebKit 272325, which randomly resets cookies carrying
  // neither Max-Age nor Expires inside a home-screen web app.
  assert.match(h, /; Max-Age=\d+/, "a session cookie without Max-Age is a live WebKit bug");
  assert.match(h, /; Secure/);
  assert.match(h, /; HttpOnly/);
  assert.match(h, /; SameSite=Lax/);
  assert.doesNotMatch(h, /Domain=/, "__Host- forbids it and the browser would drop the cookie");
  assert.match(clearSessionCookieHeader(), /Max-Age=0/);
});
