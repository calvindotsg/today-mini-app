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
  corruptHash = false,
} = {}) {
  const fields = {
    auth_date: String(authDate),
    query_id: "AAHtest",
    user: JSON.stringify({ id: userId, first_name: "Test", username: "t", language_code: "en" }),
    ...extra,
  };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  let hash = createHmac("sha256", secret).update(dcs).digest("hex");
  if (corruptHash) hash = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}
