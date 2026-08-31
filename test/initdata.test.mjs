import { test } from "node:test";
import assert from "node:assert/strict";
import { validateInitData, timingSafeEqual } from "../src/initdata.js";
import { mintInitData, FAKE_BOT_TOKEN, ALLOWED_ID } from "./helpers.mjs";

test("a real launch validates and yields the user", async () => {
  const r = await validateInitData(mintInitData(), FAKE_BOT_TOKEN);
  assert.equal(r.ok, true);
  assert.equal(r.user.id, ALLOWED_ID);
});

test("a tampered hash is refused", async () => {
  const r = await validateInitData(mintInitData({ corruptHash: true }), FAKE_BOT_TOKEN);
  assert.deepEqual(r, { ok: false, reason: "bad-hash" });
});

test("a launch signed by a DIFFERENT bot token is refused", async () => {
  const r = await validateInitData(mintInitData({ botToken: "999:other" }), FAKE_BOT_TOKEN);
  assert.equal(r.ok, false);
});

test("a launch two hours old is refused as expired", async () => {
  const authDate = Math.floor(Date.now() / 1000) - 7200;
  const r = await validateInitData(mintInitData({ authDate }), FAKE_BOT_TOKEN);
  assert.deepEqual(r, { ok: false, reason: "expired" });
});

test("a launch 14 minutes old is still accepted", async () => {
  const authDate = Math.floor(Date.now() / 1000) - 14 * 60;
  const r = await validateInitData(mintInitData({ authDate }), FAKE_BOT_TOKEN);
  assert.equal(r.ok, true);
});

test("a future-dated launch is refused", async () => {
  const authDate = Math.floor(Date.now() / 1000) + 3600;
  const r = await validateInitData(mintInitData({ authDate }), FAKE_BOT_TOKEN);
  assert.deepEqual(r, { ok: false, reason: "future-dated" });
});

// A DIFFERENT user's launch is genuinely, cryptographically VALID -- Telegram signs it with the
// same bot token. Nothing in this file can or should refuse it; the refusal is the user-id check
// in the Worker. Asserting that here is what stops someone "simplifying" the two into one.
test("another user's launch is cryptographically valid -- the id check is a SEPARATE gate", async () => {
  const r = await validateInitData(mintInitData({ userId: 999999999 }), FAKE_BOT_TOKEN);
  assert.equal(r.ok, true);
  assert.equal(r.user.id, 999999999);
  assert.notEqual(String(r.user.id), String(ALLOWED_ID));
});

test("empty, hashless and malformed input is refused without crashing", async () => {
  assert.equal((await validateInitData("", FAKE_BOT_TOKEN)).reason, "empty");
  assert.equal((await validateInitData("auth_date=1&user=%7B%7D", FAKE_BOT_TOKEN)).reason, "no-hash");
  assert.equal((await validateInitData("hash=zzz&auth_date=1", FAKE_BOT_TOKEN)).reason, "malformed-hash");
  assert.equal((await validateInitData("a=1&hash=" + "0".repeat(64), FAKE_BOT_TOKEN)).reason, "bad-hash");
  assert.equal((await validateInitData("x=1&hash=" + "0".repeat(64) + "&pad=" + "y".repeat(5000), FAKE_BOT_TOKEN)).reason, "oversized");
});

test("a valid signature with no user object is refused", async () => {
  const p = new URLSearchParams(mintInitData());
  p.delete("user");
  // Re-sign without `user` so the hash is genuinely valid and only the user is missing.
  const fields = {}; for (const [k, v] of p) if (k !== "hash") fields[k] = v;
  const { createHmac } = await import("node:crypto");
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(FAKE_BOT_TOKEN).digest();
  const q = new URLSearchParams(fields);
  q.set("hash", createHmac("sha256", secret).update(dcs).digest("hex"));
  const r = await validateInitData(q.toString(), FAKE_BOT_TOKEN);
  assert.deepEqual(r, { ok: false, reason: "no-user" });
});

test("a `signature` field is excluded from the data-check string", async () => {
  // Telegram's newer Ed25519 field rides along in initData. If it were folded into the HMAC
  // input, every real launch from a modern client would fail -- so this asserts the exclusion,
  // not merely that some string validates.
  const r = await validateInitData(mintInitData({ extra: {} }) + "&signature=abc", FAKE_BOT_TOKEN);
  assert.equal(r.ok, true);
});

test("timingSafeEqual agrees with === on equality, including on length mismatch", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});
