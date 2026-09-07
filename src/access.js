// Cloudflare Access JWT validation.
//
// Kept small and self-contained ON PURPOSE, for the same reason `initdata.js` is: the whole value
// of this file is that it can be re-read against
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
// in a minute. Do not spread it across helpers.
//
// It proves the token. It does NOT decide whose token it is -- `worker.js` compares the email,
// exactly as it compares `user.id` for a Telegram launch. That split is trap 5 and it is the whole
// reason this app does not admit everyone.
//
// 🔴 THE ACCOUNT RUNS OTHER ACCESS APPLICATIONS ON THE SAME ISSUER AND THE SAME SIGNING KEYS.
// A JWT minted for the Hermes dashboard is genuinely Cloudflare-signed, carries a valid `kid`, and
// verifies against these very certs. `aud` is the ONLY thing that separates it from this one. That
// makes `aud` this file's version of "a correctly-signed launch belonging to somebody else" -- the
// check most likely to be written loosely and the one the suite mints a real counter-example for.

import { timingSafeEqual } from "./initdata.js";

const enc = new TextEncoder();

// A TEAM DOMAIN IS INTERPOLATED INTO A URL WE THEN FETCH KEYS FROM, so it is validated as a shape
// rather than trusted as configuration. `evil.com` or `team.cloudflareaccess.com@evil.com` would
// otherwise point key retrieval at an attacker, and every signature check after it is theatre.
const TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/;

// Cloudflare rotates these. A cache with no expiry means a retired key keeps verifying for as long
// as the isolate lives, which is the wrong direction to fail in.
const JWKS_TTL_MS = 3_600_000;
// An unknown `kid` triggers a refetch, and the SECOND gate exists precisely for a world where
// Access is gone and anything can reach this code -- so an attacker who can invent `kid`s must not
// be able to invent outbound subrequests at the same rate.
const REFETCH_COOLDOWN_MS = 60_000;
const MAX_KEYS = 16;

// Keyed by certs URL so a test pointing at a local JWKS cannot be served the real one, and so two
// URLs never share an entry.
const jwksCache = new Map();

/** Test seam. The suite mints its own keys and must not inherit another test's cache. */
export function _resetJwksCache() {
  jwksCache.clear();
}

function b64urlToBytes(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function loadKeys(certsUrl, nowMs) {
  const hit = jwksCache.get(certsUrl);
  if (hit && nowMs - hit.fetchedAt < JWKS_TTL_MS) return hit;

  // A redirect on a key endpoint is not a thing that legitimately happens, and following one
  // silently is how key retrieval gets moved somewhere else. So it is refused -- but with
  // `manual` plus an explicit check, NOT with `redirect: "error"`.
  // ⚠️ `redirect: "error"` is standard fetch and workerd does NOT support it: it THROWS rather
  // than being honoured, so the request never leaves the isolate. That failure is invisible from
  // the outside -- it surfaces as `jwks-unavailable`, i.e. exactly as if the key server were down,
  // and every valid token is refused while every negative test still passes. Found the honest way,
  // by a positive control failing while all thirteen negative controls stayed green.
  const res = await fetch(certsUrl, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new Error("jwks-redirected");
  if (!res.ok) throw new Error("jwks-unavailable");
  const body = await res.json();
  const keys = Array.isArray(body?.keys) ? body.keys.slice(0, MAX_KEYS) : [];
  const entry = { keys, fetchedAt: nowMs, lastRefetchAt: nowMs };
  jwksCache.set(certsUrl, entry);
  return entry;
}

// The key's OWN `alg` and `kty` are checked, not just the header's. A JWKS entry that is not an
// RS256 signing key has no business being imported as one, whatever the token claims.
async function importKey(jwk) {
  if (jwk?.kty !== "RSA" || jwk?.alg !== "RS256") return null;
  if (jwk.use !== undefined && jwk.use !== "sig") return null;
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

/**
 * @param {string} token the `Cf-Access-Jwt-Assertion` header value
 * @param {{teamDomain: string, aud: string, nowMs?: number, certsUrl?: string, skewSeconds?: number}} opts
 * @returns {Promise<{ok: true, email: string, sub: string} | {ok: false, reason: string}>}
 *
 * `reason` is for tests and for a human reading a failure by hand. It is NEVER put in a response
 * body or a log line -- a caller that tells a stranger WHICH check failed has built an oracle out
 * of its error messages. Same rule as `initdata.js`.
 */
export async function verifyAccessJwt(token, opts) {
  const { teamDomain, aud, nowMs = Date.now(), skewSeconds = 60 } = opts ?? {};

  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "empty" };
  if (token.length > 8192) return { ok: false, reason: "oversized" };
  if (typeof teamDomain !== "string" || !TEAM_DOMAIN.test(teamDomain)) {
    return { ok: false, reason: "bad-team-domain" };
  }
  if (typeof aud !== "string" || !/^[0-9a-f]{64}$/.test(aud)) return { ok: false, reason: "bad-aud-config" };

  // EXACTLY three segments. A five-segment JWE-shaped token would otherwise have its first three
  // verified while the claims were read from a part that was never signed.
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "not-a-jws" };

  let header;
  try {
    header = b64urlToJson(parts[0]);
  } catch {
    return { ok: false, reason: "bad-header" };
  }

  // 🔴 `alg` IS A CONSTANT HERE, NEVER A SELECTOR. Reading the algorithm out of the header and
  // dispatching on it is the whole of algorithm confusion: `none` verifies nothing, and `HS256`
  // lets an attacker sign with the RSA modulus, which is public. We accept one algorithm and
  // compare the header's claim to it.
  if (header?.alg !== "RS256") return { ok: false, reason: "bad-alg" };
  if (typeof header.kid !== "string" || header.kid.length === 0) return { ok: false, reason: "no-kid" };

  // EVERY CHEAP CHECK HAPPENS BEFORE ANY NETWORK CALL, so a stream of structurally invalid tokens
  // costs no subrequests at all.
  const certsUrl = opts.certsUrl ?? `https://${teamDomain}/cdn-cgi/access/certs`;

  let entry;
  try {
    entry = await loadKeys(certsUrl, nowMs);
  } catch {
    return { ok: false, reason: "jwks-unavailable" };
  }

  let jwk = entry.keys.find((k) => k?.kid === header.kid);
  if (!jwk && nowMs - entry.lastRefetchAt >= REFETCH_COOLDOWN_MS) {
    // A genuine rotation shows up as an unknown `kid`, so one refetch is correct. The cooldown is
    // what stops a forged-`kid` flood from turning into an outbound request flood.
    jwksCache.delete(certsUrl);
    try {
      entry = await loadKeys(certsUrl, nowMs);
      jwk = entry.keys.find((k) => k?.kid === header.kid);
    } catch {
      return { ok: false, reason: "jwks-unavailable" };
    }
  }
  if (!jwk) return { ok: false, reason: "unknown-kid" };

  const key = await importKey(jwk);
  if (!key) return { ok: false, reason: "bad-jwk" };

  let sig;
  try {
    sig = b64urlToBytes(parts[2]);
  } catch {
    return { ok: false, reason: "bad-signature-encoding" };
  }
  const signed = enc.encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signed);
  if (!valid) return { ok: false, reason: "bad-signature" };

  // Only past this line is anything in the token trustworthy.

  let claims;
  try {
    claims = b64urlToJson(parts[1]);
  } catch {
    return { ok: false, reason: "bad-claims" };
  }

  // PRESENCE AND TYPE BEFORE COMPARISON, every time. `undefined < now` is `false`, so the natural
  // shape `if (claims.exp < now) reject` accepts a token with no `exp` AT ALL and never expires it.
  // The same hole exists for every claim below, which is why each is typed before it is read.
  if (typeof claims?.exp !== "number") return { ok: false, reason: "no-exp" };
  if (typeof claims.iss !== "string") return { ok: false, reason: "no-iss" };
  if (typeof claims.email !== "string" || claims.email.length === 0) return { ok: false, reason: "no-email" };

  const nowSec = Math.floor(nowMs / 1000);
  // 🔴 NO GRACE PAST `exp`. The skew allowance below is for tokens that look FUTURE-dated, which is
  // a real clock difference; extending a credential's life past its stated expiry is the opposite,
  // and is the wrong direction to be generous in. `initdata.js` draws exactly this asymmetry --
  // `ageSeconds > maxAgeSeconds` is refused outright while `ageSeconds < -60` is tolerated -- and
  // an earlier draft here got it backwards. A positive control caught it: a token that had expired
  // sixty seconds ago was still minting a thirty-day session, while every negative test stayed green.
  if (nowSec > claims.exp) return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && nowSec + skewSeconds < claims.nbf) return { ok: false, reason: "not-yet-valid" };
  if (typeof claims.iat === "number" && nowSec + skewSeconds < claims.iat) return { ok: false, reason: "future-dated" };

  if (!timingSafeEqual(claims.iss, `https://${teamDomain}`)) return { ok: false, reason: "bad-iss" };

  // 🔴 `aud` IS AN ARRAY in Cloudflare Access tokens, and this is the check that keeps the account's
  // OTHER Access applications out. `String(claims.aud).includes(aud)` would pass on a superstring
  // and `claims.aud === aud` would fail on the array -- one is a hole, the other is an outage.
  // Exact match against an element, and nothing else.
  const auds = Array.isArray(claims.aud) ? claims.aud : typeof claims.aud === "string" ? [claims.aud] : null;
  if (!auds || auds.length === 0) return { ok: false, reason: "no-aud" };
  let audMatch = false;
  for (const a of auds) {
    if (typeof a === "string" && timingSafeEqual(a, aud)) audMatch = true;
  }
  if (!audMatch) return { ok: false, reason: "bad-aud" };

  return { ok: true, email: claims.email, sub: typeof claims.sub === "string" ? claims.sub : "" };
}
