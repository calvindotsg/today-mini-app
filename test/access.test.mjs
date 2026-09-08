// Cloudflare Access JWT validation, exercised against tokens minted the way CLOUDFLARE mints them
// -- node's own RSA signing, against a JWKS this test serves -- never by calling the checker.
//
// The rule is `initdata.test.mjs`'s and it is not decoration: a suite that builds its fixtures with
// the checker's own code agrees with the checker by construction. That is exactly how the
// `signature` bug shipped past a green suite.
//
// 🔴 THE TEST THAT MATTERS MOST is "a token for another Access application". Calvin's account runs
// two Hermes apps on the same issuer with the same signing keys, so such a token is GENUINELY
// Cloudflare-signed and differs from a valid one in `aud` alone. It is this file's version of "a
// correctly-signed launch belonging to somebody else" -- the one most likely to be skipped, and the
// only one that proves the audience check exists at all.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { verifyAccessJwt, _resetJwksCache } from "../src/access.js";
import { accessKeypair, jwksBody, mintAccessJwt, FAKE_ACCESS_AUD, FAKE_TEAM_DOMAIN } from "./helpers.mjs";

let key, otherKey, server, certsUrl, served = 0;

before(async () => {
  key = await accessKeypair("kid-primary");
  otherKey = await accessKeypair("kid-stranger");
  server = createServer((req, res) => {
    served++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(jwksBody(key));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  certsUrl = `http://127.0.0.1:${server.address().port}/cdn-cgi/access/certs`;
});

after(() => server?.close());

const opts = (over = {}) => ({
  teamDomain: FAKE_TEAM_DOMAIN,
  aud: FAKE_ACCESS_AUD,
  certsUrl,
  nowMs: Date.now(),
  ...over,
});

const verify = async (token, over) => {
  _resetJwksCache(); // no test may inherit another's keys
  return verifyAccessJwt(token, opts(over));
};

// ── the positive control, first, because a checker that refuses everything passes every test below
test("a genuine Access token for this application is accepted", async () => {
  const r = await verify(await mintAccessJwt(key));
  assert.equal(r.ok, true, "a valid token must be ACCEPTED — without this the suite proves nothing");
  assert.equal(r.email, "someone@example.com");
});

test("a string aud is accepted too, because Cloudflare has shipped both shapes", async () => {
  const r = await verify(await mintAccessJwt(key, { audAsString: true }));
  assert.equal(r.ok, true);
});

// ── the one that guards the account's other applications ────────────────────────────────────
test("a token for ANOTHER Access application on the same account is refused", async () => {
  // Same issuer, same signing key, same everything — Cloudflare really did sign this. Only `aud`
  // differs, exactly as a Hermes dashboard token would.
  const hermesAud = "f".repeat(64);
  const r = await verify(await mintAccessJwt(key, { aud: hermesAud }));
  assert.equal(r.ok, false, "a sibling application's token must not open this one");
  assert.equal(r.reason, "bad-aud");
});

test("an aud that merely CONTAINS the configured one is refused", async () => {
  // Guards `String(aud).includes(...)`, which passes on any superstring.
  const r = await verify(await mintAccessJwt(key, { aud: FAKE_ACCESS_AUD.slice(0, 63) + "0" }));
  assert.equal(r.ok, false);
});

// ── algorithm confusion ─────────────────────────────────────────────────────────────────────
test("alg:none is refused", async () => {
  const r = await verify(await mintAccessJwt(key, { alg: "none" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-alg");
});

test("alg:HS256 is refused before any key is chosen", async () => {
  const r = await verify(await mintAccessJwt(key, { alg: "HS256" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-alg");
});

// ── claims that are absent rather than wrong ────────────────────────────────────────────────
//
// The natural shape `if (claims.exp < now) reject` ACCEPTS a token with no exp at all, because
// `undefined < now` is false. These prove presence is required, not just value.
test("a token with NO exp is refused rather than treated as never expiring", async () => {
  const r = await verify(await mintAccessJwt(key, { omit: ["exp"] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-exp");
});

test("a token with NO aud is refused", async () => {
  const r = await verify(await mintAccessJwt(key, { omit: ["aud"] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-aud");
});

test("a token with NO email is refused", async () => {
  const r = await verify(await mintAccessJwt(key, { omit: ["email"] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-email");
});

test("a token with NO iss is refused", async () => {
  const r = await verify(await mintAccessJwt(key, { omit: ["iss"] }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-iss");
});

// ── the ordinary refusals ───────────────────────────────────────────────────────────────────
test("a token that expired ONE SECOND ago is refused", async () => {
  // The tight boundary on purpose. An hour-old token is refused by any implementation; this is the
  // one that catches a clock-skew allowance applied to `exp` in the wrong direction, which is what
  // an earlier draft did -- sixty seconds of grace PAST expiry.
  const nowSec = Math.floor(Date.now() / 1000);
  const r = await verify(await mintAccessJwt(key, { expSec: nowSec - 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
});

test("a token from another team is refused even when correctly signed", async () => {
  const r = await verify(await mintAccessJwt(key, { iss: "https://someone-else.cloudflareaccess.com" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-iss");
});

test("a tampered payload is refused", async () => {
  const r = await verify(await mintAccessJwt(key, { tamper: true }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
});

test("a token signed by a key the JWKS does not publish is refused", async () => {
  // Correct shape, correct kid header, wrong signer.
  const r = await verify(await mintAccessJwt(otherKey, { kid: "kid-primary" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-signature");
});

test("an unknown kid is refused", async () => {
  const r = await verify(await mintAccessJwt(key, { kid: "kid-nobody" }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unknown-kid");
});

test("a five-segment JWE-shaped token is refused rather than partly verified", async () => {
  const r = await verify((await mintAccessJwt(key)) + ".extra.parts");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-a-jws");
});

test("an empty or oversized token is refused without touching the network", async () => {
  assert.equal((await verify("")).reason, "empty");
  assert.equal((await verify("x".repeat(9000))).reason, "oversized");
});

// ── the team domain is interpolated into a URL, so it is validated as a shape ────────────────
test("a team domain that is not a cloudflareaccess.com host is refused", async () => {
  for (const bad of ["evil.com", "team.cloudflareaccess.com@evil.com", "", "http://x.cloudflareaccess.com"]) {
    const r = await verify(await mintAccessJwt(key), { teamDomain: bad });
    assert.equal(r.ok, false, `${bad} must not be accepted as a team domain`);
    assert.equal(r.reason, "bad-team-domain");
  }
});

test("a malformed configured aud is refused rather than compared", async () => {
  const r = await verify(await mintAccessJwt(key), { aud: "" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad-aud-config");
});

// ── the cheap checks must come first, or a forged-kid flood becomes a subrequest flood ───────
test("structurally invalid tokens cost NO fetch of the key set", async () => {
  _resetJwksCache();
  const before_ = served;
  await verifyAccessJwt("not-a-jwt", opts());
  await verifyAccessJwt("a.b", opts());
  await verifyAccessJwt((await mintAccessJwt(key, { alg: "none" })), opts());
  assert.equal(served, before_, "no key set should have been fetched for any of these");
});
