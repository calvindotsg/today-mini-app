// Mint initData exactly the way Telegram does, so the suite exercises the real algorithm rather
// than a re-implementation of the checker. If this and initdata.js ever disagree, one of them is
// wrong about the docs -- which is the point.
import { createHmac } from "node:crypto";

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
