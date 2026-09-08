// Mint initData exactly the way Telegram does, so the suite exercises the real algorithm rather
// than a re-implementation of the checker. If this and initdata.js ever disagree, one of them is
// wrong about the docs -- which is the point.
import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, delimiter } from "node:path";

export const FAKE_BOT_TOKEN = "123456:AAH-test-token-not-a-real-one";
// A STAND-IN, deliberately not the real id. The one allowed id lives only in the Worker secret,
// so this repository carries no personal identifier and could be made public without a redaction
// pass. The tests are exactly as strong with an arbitrary number: what they prove is that ONE id
// is admitted and every other one is refused.
export const ALLOWED_ID = 1000000001;

export function mintInitData({
  botToken = FAKE_BOT_TOKEN,
  userId = ALLOWED_ID,
  authDate = Math.floor(Date.now() / 1000),
  extra = {},
  omit = null,
  dcsOmit = null,
  corruptHash = false,
} = {}) {
  // The field set a REAL client sends, not a minimal one. `signature` and `chat_instance` are
  // both present on every modern launch, and a fixture that omits them cannot catch a checker
  // that mishandles them — which is exactly how a signature bug shipped and passed 34 tests.
  const fields = {
    auth_date: String(authDate),
    chat_instance: "-1234567890123456789",
    chat_type: "sender",
    query_id: "AAHtest",
    signature: "Zm9vYmFyc2lnbmF0dXJlZXhhbXBsZQ",
    user: JSON.stringify({ id: userId, first_name: "Test", username: "t", language_code: "en" }),
    ...extra,
  };
  if (omit) for (const k of omit) delete fields[k];
  // Every field except `hash` goes into the data-check-string. `dcsOmit` exists ONLY so a test
  // can build the WRONG string on purpose and prove the checker rejects it.
  const dcsKeys = Object.keys(fields).filter((k) => !(dcsOmit ?? []).includes(k)).sort();
  const dcs = dcsKeys.map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  let hash = createHmac("sha256", secret).update(dcs).digest("hex");
  if (corruptHash) hash = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}

// ── THE SANDBOX EVERY TEST THAT SPAWNS THE PUBLISHER MUST USE ────────────────────────────────
//
// 🔴 THIS EXISTS BECAUSE A TEST RUN PUBLISHED A FIXTURE TO PRODUCTION KV. On 2026-09-02 a
// mutation-testing pass removed the `process.exit(0)` from `publish.mjs`'s `if (!put)` block --
// a legitimate mutation, checking that the notification cannot fire on a dry run. Execution then
// fell through to the real `npx wrangler kv key put` and the real `ssh`, and the tests in
// publish.test.mjs, which deliberately run WITHOUT `--put`, published their fixture over Calvin's
// real week. The mutation was "caught" -- tests went red -- so the report looked correct while the
// damage was already done.
//
// The lesson is not "write safer mutations". A mutation pass exists precisely to run code paths
// that are supposed to be unreachable, so **the blast radius has to be bounded by the environment
// rather than by the code under test.** `publish.mjs` resolves `npx` and `ssh` from PATH, so a
// PATH that cannot reach either makes production unreachable by construction, whatever the source
// says on any given mutation.
//
// ⚠️ THE SHIMS EXIT NON-ZERO AND SAY WHY. A silent no-op would let a future fall-through pass
// unnoticed; a loud failure turns "a test tried to reach production" into a red test naming the
// tool it tried to reach.
export function sandboxBin(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [tool, why] of [
    ["npx", "wrangler/KV"],
    ["ssh", "the Hermes box"],
    ["wrangler", "KV"],
  ]) {
    const p = join(dir, tool);
    writeFileSync(p,
      `#!/bin/sh\n` +
      `echo "REFUSED: a test invoked \\\`${tool}\\\` and would have reached ${why}." >&2\n` +
      `echo "See sandboxBin() in test/helpers.mjs -- 2026-09-02, a fixture reached production KV." >&2\n` +
      `exit 97\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

/** The env a spawned publisher must be given: PATH with the refusing shims in front. */
export function sandboxEnv(dir) {
  return { ...process.env, PATH: `${sandboxBin(dir)}${delimiter}${process.env.PATH}` };
}

// ── the browser / home-screen way in ─────────────────────────────────────────────────────────
//
// Same principle as mintInitData above, and for the same reason: these mint credentials the way
// CLOUDFLARE and the cookie format do, using node's crypto directly, never by calling access.js or
// session.js. A suite that builds its fixtures with the checker's own code agrees with the checker
// by construction and cannot catch it being wrong -- which is precisely how the `signature` bug
// shipped past 34 green tests.

// STAND-INS, deliberately not the real values, so this repository still carries no personal
// identifier and could be made public without a redaction pass. They match .dev.vars.example.
export const FAKE_ALLOWED_EMAIL = "someone@example.com";
export const FAKE_SESSION_SECRET = "local-dev-session-signing-key-not-a-real-one";
export const FAKE_ACCESS_AUD = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const FAKE_TEAM_DOMAIN = "example-team.cloudflareaccess.com";

const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** An RSA signing key plus the public JWK a JWKS endpoint would publish for it. */
export async function accessKeypair(kid = "test-key-1") {
  const { generateKeyPairSync } = await import("node:crypto");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  return { kid, privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

/** The body Cloudflare's /cdn-cgi/access/certs returns. */
export function jwksBody(...keys) {
  return JSON.stringify({ keys: keys.map((k) => k.jwk) });
}

/**
 * Mint an Access JWT the way Cloudflare mints one.
 *
 * Every knob here exists so a test can build a token that is WRONG IN EXACTLY ONE WAY and prove
 * the checker refuses it: a different audience (which is how a token for one of the account's
 * OTHER Access applications is simulated -- same issuer, same signing key, same everything else),
 * a missing `exp`, a swapped algorithm, a tampered payload.
 */
export async function mintAccessJwt(key, {
  email = FAKE_ALLOWED_EMAIL,
  aud = FAKE_ACCESS_AUD,
  teamDomain = FAKE_TEAM_DOMAIN,
  iss = null,
  nowSec = Math.floor(Date.now() / 1000),
  expSec = null,
  nbfSec = null,
  alg = "RS256",
  kid = null,
  audAsString = false,
  omit = [],
  tamper = false,
  extraClaims = {},
} = {}) {
  const { sign } = await import("node:crypto");
  const header = { alg, kid: kid ?? key.kid, typ: "JWT" };
  const claims = {
    aud: audAsString ? aud : [aud],
    email,
    iss: iss ?? `https://${teamDomain}`,
    iat: nowSec,
    exp: expSec ?? nowSec + 3600,
    sub: "test-subject",
    ...(nbfSec === null ? {} : { nbf: nbfSec }),
    ...extraClaims,
  };
  for (const k of omit) delete claims[k];
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  // `alg: none` carries no signature at all -- the whole point of that attack.
  const sig = alg === "none" ? "" : b64u(sign("sha256", Buffer.from(signingInput), key.privateKey));
  const token = `${signingInput}.${sig}`;
  if (!tamper) return token;
  // Swap the claims while keeping the signature, which is what a payload edit looks like on the wire.
  const parts = token.split(".");
  const bad = { ...claims, email: "someone-else@example.com" };
  return `${parts[0]}.${b64u(JSON.stringify(bad))}.${parts[2]}`;
}

/**
 * Mint a session cookie value with node's HMAC, mirroring session.js's wire format without
 * importing it. `v1.<iatMs>.<expMs>.<b64url(email)>.<mac>`, MAC over the raw prefix.
 */
export async function mintSessionCookie({
  email = FAKE_ALLOWED_EMAIL,
  secret = FAKE_SESSION_SECRET,
  nowMs = Date.now(),
  iatMs = null,
  ttlMs = 30 * 24 * 3_600_000,
  version = "v1",
  corruptMac = false,
  fields = null,
} = {}) {
  const { createHmac } = await import("node:crypto");
  const iat = iatMs ?? nowMs;
  const payload = fields ?? `${version}.${iat}.${nowMs + ttlMs}.${b64u(Buffer.from(email, "utf8"))}`;
  let mac = createHmac("sha256", secret).update(payload).digest("base64url");
  if (corruptMac) mac = (mac[0] === "A" ? "B" : "A") + mac.slice(1);
  return `${payload}.${mac}`;
}
