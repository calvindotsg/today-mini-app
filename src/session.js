// The browser/PWA session cookie: minting, verifying, and the two lifetimes.
//
// WHY THIS EXISTS AT ALL. Cloudflare Access answers "who are you" and it answers it by sending the
// reader to a DIFFERENT ORIGIN and back. An iOS home-screen web app has no address bar, no reload
// and no back button, so a login that has to leave the origin on every cold start is a login that
// can strand the app with no way out. So Access is used ONCE, at /web/signin, and this cookie
// answers "are you still you" on every request after it -- first-party, no redirect, no bridge.
//
// It is STATELESS. Nothing is written to KV, so the Worker keeps its "no write path" property and a
// compromise still yields one week of training plan and nothing else.

import { timingSafeEqual } from "./initdata.js";

const enc = new TextEncoder();

export const COOKIE_NAME = "__Host-today_session";

// THE TWO LIFETIMES, and they are different things.
//   TTL      -- how long a cookie is good for, refreshed by use.
//   ABSOLUTE -- how long the SESSION may live, from first sign-in, no matter how much it is used.
// Sliding renewal without the second is an unbounded session: a stolen cookie that gets loaded once
// a month never expires. Calvin asked for "about a week"; 30 days with a hard 90-day ceiling is the
// settled answer, and the ceiling is what makes the Access session duration mean anything.
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 3_600_000;
// Re-issue when the remaining life has dropped by a week, so a daily reader never sees a login and
// an abandoned session still dies on schedule.
export const RENEW_AFTER_MS = 7 * 24 * 3_600_000;

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function mac(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return b64url(sig);
}

/**
 * READ ONE COOKIE, AND REFUSE AMBIGUITY.
 *
 * A `Cookie` header may legitimately carry the same name twice -- different paths, different
 * domains, a stale one alongside a fresh one. A parser that takes the first match lets an attacker
 * who can set a cookie anywhere on the domain decide which one is read. `__Host-` makes that hard,
 * but "hard" is not the same as "impossible", and the honest answer to two candidates is to trust
 * neither. Returns null when absent OR duplicated.
 */
export function readCookie(header, name = COOKIE_NAME) {
  if (typeof header !== "string" || header.length === 0) return null;
  let found = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    if (found !== null) return null; // two of them: refuse rather than choose
    found = part.slice(eq + 1).trim();
  }
  return found;
}

/**
 * `v1.<iatMs>.<expMs>.<b64url(email)>.<mac>`
 *
 * Versioned, so a future format change is distinguishable from a forgery rather than being read as
 * one. The email is base64url-encoded because it CONTAINS DOTS -- a naive `split(".")` on a raw
 * address silently truncates the subject and then verifies a different string than it parsed.
 */
export async function mintSession(email, opts) {
  const { secret, nowMs = Date.now(), iatMs = nowMs, ttlMs = SESSION_TTL_MS } = opts ?? {};
  const expMs = Math.min(nowMs + ttlMs, iatMs + SESSION_ABSOLUTE_MS);
  const payload = `v1.${iatMs}.${expMs}.${b64url(enc.encode(email))}`;
  return `${payload}.${await mac(secret, payload)}`;
}

/**
 * @returns {Promise<{ok: true, email: string, iatMs: number, expMs: number} | {ok: false, reason: string}>}
 * `reason` never reaches a response body, for the same reason it never does in `initdata.js`.
 */
export async function verifySession(value, opts) {
  const { secret, nowMs = Date.now() } = opts ?? {};
  if (typeof value !== "string" || value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > 1024) return { ok: false, reason: "oversized" };
  if (typeof secret !== "string" || secret.length < 32) return { ok: false, reason: "no-secret" };

  // EXACTLY five fields. A shorter value must not be padded into a valid one, and a longer one must
  // not have its tail ignored.
  const parts = value.split(".");
  if (parts.length !== 5) return { ok: false, reason: "malformed" };
  if (parts[0] !== "v1") return { ok: false, reason: "bad-version" };

  // 🔴 THE MAC COVERS THE RAW PREFIX, BYTE FOR BYTE -- not the fields re-joined, and not their
  // concatenation. Signing `iat + exp` rather than the delimited string lets bytes shift between
  // fields: (iat=1, exp=23) and (iat=12, exp=3) would share a signature.
  const cut = value.lastIndexOf(".");
  const payload = value.slice(0, cut);
  const given = value.slice(cut + 1);
  const expected = await mac(secret, payload);
  if (!timingSafeEqual(given, expected)) return { ok: false, reason: "bad-mac" };

  // Only past this line is anything in the cookie trustworthy.

  const iatMs = Number(parts[1]);
  const expMs = Number(parts[2]);
  if (!Number.isFinite(iatMs) || !Number.isFinite(expMs)) return { ok: false, reason: "bad-times" };
  if (nowMs > expMs) return { ok: false, reason: "expired" };
  // The ceiling is enforced on READ as well as on mint, so a cookie minted by an older build with a
  // longer life cannot outlive the policy.
  if (nowMs > iatMs + SESSION_ABSOLUTE_MS) return { ok: false, reason: "past-absolute" };

  let email;
  try {
    email = b64urlDecode(parts[3]);
  } catch {
    return { ok: false, reason: "bad-email-encoding" };
  }
  if (!email) return { ok: false, reason: "no-email" };

  return { ok: true, email, iatMs, expMs };
}

/** True when the cookie has lost a week of life and should be re-issued on this response. */
export function shouldRenew(session, nowMs = Date.now()) {
  if (!session?.ok) return false;
  if (nowMs > session.iatMs + SESSION_ABSOLUTE_MS - RENEW_AFTER_MS) return false; // near the ceiling: let it die
  return session.expMs - nowMs < SESSION_TTL_MS - RENEW_AFTER_MS;
}

/**
 * 🔴 `Max-Age` IS LOAD-BEARING, NOT TIDINESS. WebKit bug 272325 -- open, reported through iOS 18.1
 * -- randomly resets cookies that carry NEITHER `Max-Age` NOR `Expires` inside a home-screen web
 * app. A "simplification" to a session cookie resurrects a live WebKit bug.
 *
 * 🔴 SET FROM THE SERVER, NEVER FROM JAVASCRIPT. Safari's ITP caps script-written cookies at seven
 * days; a server `Set-Cookie` is exempt. Writing this from `document.cookie` would quietly turn a
 * 30-day session into a weekly one, with nothing to see in any log.
 *
 * `__Host-` forbids a `Domain` attribute, so no other calvin.sg subdomain can inject one. It also
 * FORCES `Path=/`, which means this cookie is sent on `GET /` too -- harmless, because that route
 * never reads it, but do not later assume it is scoped to /web/.
 */
export function sessionCookieHeader(value, maxAgeSeconds) {
  return `${COOKIE_NAME}=${value}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
