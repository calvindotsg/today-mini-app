// Telegram Mini App `initData` validation.
//
// Kept small and self-contained ON PURPOSE. Telegram may change the scheme, and the whole
// value of this file is that it can be re-read against
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// in under a minute. Do not spread it across helpers.
//
// The four steps, from those docs:
//   1. take `hash` out of the query string
//   2. data_check_string = the remaining pairs, sorted by key, "k=v" joined with "\n"
//   3. secret_key = HMAC_SHA256(<bot_token>, "WebAppData")   -- key is the LITERAL, data is the token
//   4. compare hex(HMAC_SHA256(data_check_string, secret_key)) with the received hash
//
// Everything here runs on WebCrypto, which the Workers runtime and Node >= 18 both provide.

const enc = new TextEncoder();

async function hmac(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, messageBytes));
}

function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Constant-time string comparison.
//
// A byte-by-byte early exit is a timing oracle: an attacker who can measure it learns the hash
// one nibble at a time. This walks a FIXED number of positions regardless of where the first
// difference is, and folds a length mismatch into the same accumulator rather than returning
// early on it -- an early `a.length !== b.length` return is itself a (much coarser) oracle.
export function timingSafeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}

/**
 * @param {string} initData raw query string as Telegram hands it over
 * @param {string} botToken
 * @param {{nowMs?: number, maxAgeSeconds?: number}} opts
 * @returns {Promise<{ok: true, user: object, authDate: number} | {ok: false, reason: string}>}
 *
 * `reason` is for tests and for a human reading a failure by hand. It is NEVER put in a response
 * body or a log line: a caller that tells a stranger *which* check failed has built an oracle out
 * of the error message.
 */
export async function validateInitData(initData, botToken, opts = {}) {
  const { nowMs = Date.now(), maxAgeSeconds = 900 } = opts;

  if (typeof initData !== "string" || initData.length === 0) return { ok: false, reason: "empty" };
  if (typeof botToken !== "string" || botToken.length === 0) return { ok: false, reason: "no-bot-token" };
  // A pathological length is rejected before any parsing or crypto happens.
  if (initData.length > 4096) return { ok: false, reason: "oversized" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no-hash" };
  // Telegram's hash is 64 lowercase hex characters. Anything else cannot be a valid hash, and
  // saying so here keeps `timingSafeEqual` comparing two strings of the same shape.
  if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "malformed-hash" };

  // ONLY `hash` comes out. The docs are explicit: the data-check-string is "a chain of ALL
  // received fields, sorted alphabetically".
  //
  // 🔴 An earlier version also skipped `signature`, and that broke every launch from a real
  // client while passing the entire suite. `signature` IS excluded — but from the OTHER check:
  // the Ed25519 third-party validation, which does not use the bot token at all. Applying one
  // check's exclusion list to the other is silent and total: modern clients always send
  // `signature`, so the app refused its own owner while every hand-minted fixture passed.
  const pairs = [];
  for (const [k, v] of params) {
    if (k === "hash") continue;
    pairs.push(`${k}=${v}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secret = await hmac(enc.encode("WebAppData"), enc.encode(botToken));
  const computed = toHex(await hmac(secret, enc.encode(dataCheckString)));

  if (!timingSafeEqual(computed, hash)) return { ok: false, reason: "bad-hash" };

  // Only past this line is anything in `initData` trustworthy.

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: "no-auth-date" };
  const ageSeconds = Math.floor(nowMs / 1000) - authDate;
  // Future-dated launches are refused too. A clock skew of a few seconds is normal, so allow a
  // small negative window rather than requiring monotonicity we do not have.
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: "expired" };
  if (ageSeconds < -60) return { ok: false, reason: "future-dated" };

  let user;
  try {
    user = JSON.parse(params.get("user") ?? "null");
  } catch {
    return { ok: false, reason: "bad-user-json" };
  }
  if (!user || typeof user.id !== "number") return { ok: false, reason: "no-user" };

  return { ok: true, user, authDate };
}
