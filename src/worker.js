// today.calvin.sg -- the Telegram Mini App's whole server.
//
// It does two things: prove who is asking, and serve one screen. It has no write path, no data
// endpoint, and no second reader. The publisher writes to KV through the Cloudflare API from a
// Mac, NOT through this Worker, so there is no authenticated-write surface on a public hostname
// at all.
//
// WHAT AN ATTACKER GETS if this Worker is fully compromised: one week of Calvin's training plan.
// Not the Hermes box (which accepts no inbound connection of any kind), not a credential for it,
// not the agent. That containment is the reason this is served from the edge rather than from
// the box, and nothing here should be changed in a way that widens it.

import { validateInitData } from "./initdata.js";
import { buildView } from "./view.js";
import APP_HTML from "./app.html";

const KV_KEY = "week:current";
const MAX_INITDATA_AGE_SECONDS = 900; // 15 minutes. A captured launch is useless after that.

function nonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[^A-Za-z0-9]/g, "");
}

function securityHeaders(n) {
  return {
    // 'none' by default, then exactly what each page needs. The nonce means no 'unsafe-inline'
    // anywhere, which is the difference between a CSP and a decoration.
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${n}'`,
      `style-src 'nonce-${n}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      // Telegram Desktop and the web client run a Mini App in an iframe on web.telegram.org;
      // the mobile clients use a native webview, where this header does not apply.
      "frame-ancestors https://web.telegram.org",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // The plan is personal and short-lived. Nothing about it should sit in a shared cache, and
    // the authenticated response must never be stored at all.
    "Cache-Control": "no-store",
    "Permissions-Policy": "geolocation=(), camera=(), microphone=(), payment=()",
  };
}

// One rejection, one shape, no body. A 401 that still ships the page in the body is a real bug
// and an easy one to write, so the empty body is asserted by the suite rather than assumed.
function deny() {
  return new Response(null, {
    status: 401,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function html(body, n, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(n) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Fail CLOSED on missing configuration. A Worker deployed without its secrets must refuse
    // everyone, not serve everyone -- an unset ALLOWED_USER_ID that read as "no restriction"
    // would make the app public on the day someone forgot a `wrangler secret put`.
    const configured = typeof env.BOT_TOKEN === "string" && env.BOT_TOKEN.length > 0
      && typeof env.ALLOWED_USER_ID === "string" && /^\d+$/.test(env.ALLOWED_USER_ID);

    // ONE DOCUMENT, served to anyone. It carries the design and the renderer and NO TRAINING
    // DATA -- the week only ever arrives through POST /s below. It used to be a contentless
    // shell that `document.write`-replaced itself with a second, separately-served page, so that
    // not even the stylesheet reached a stranger. That cannot work behind a CSP nonce: the
    // written markup is judged against THIS response's policy, the second response's nonce
    // matches nothing, and the page renders blank with no error. See src/app.html.
    if (request.method === "GET" && url.pathname === "/") {
      const n = nonce();
      return html(APP_HTML.replaceAll("__NONCE__", n), n);
    }

    if (url.pathname === "/s") {
      if (request.method !== "POST") return deny();
      if (!configured) return deny();

      // THE BODY, not a header. A header value is a constrained byte range, while `initData`
      // carries a JSON `user` object with a display name that is arbitrary UTF-8 — an emoji in
      // someone's first name is enough to make the header illegal and the request throw on the
      // client, which surfaces as a blank refusal with nothing in any log. A body is UTF-8 by
      // definition.
      // `.trim()` because a transport that appends a newline is a transport bug, not an
      // authentication decision. Found the honest way: a shell pipeline added one and turned a
      // valid launch into `malformed-hash`, which is indistinguishable from an attack in the
      // response and from nothing at all in the logs.
      const initData = (await request.text()).trim().slice(0, 8192);
      const result = await validateInitData(initData, env.BOT_TOKEN, {
        nowMs: Date.now(),
        maxAgeSeconds: MAX_INITDATA_AGE_SECONDS,
      });
      if (!result.ok) return deny();

      // THE ACCESS CONTROL. Everything above proves the launch came from this bot; only this
      // line decides whose launch it was. String comparison against the configured id: the id
      // arrives as a JSON number and the secret as text, and coercing one to the other is where
      // a `==` bug lives.
      if (String(result.user.id) !== env.ALLOWED_USER_ID) return deny();

      let payload = null;
      try {
        payload = await env.WEEK.get(KV_KEY, { type: "json" });
      } catch {
        payload = null; // buildView renders "no plan published" honestly rather than blank.
      }

      // JSON, not a page. The document is already loaded and already has its nonce; this
      // request exists only to carry the week across the authentication boundary.
      // ⚠️ ADDED BESIDE THE VIEW, NOT INSIDE buildView. The view is a pure function of the
      // published week; which screen to open on is a fact about THIS LAUNCH and belongs to the
      // response, not to the plan. Merging it into buildView would make the same week render
      // two different shapes and every view assertion depend on a launch.
      return new Response(JSON.stringify({ ...buildView(payload, Date.now()), startParam: result.startParam }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // Everything else, including HEAD and any probe for a data file, gets nothing.
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  },
};
