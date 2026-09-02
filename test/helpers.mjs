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
