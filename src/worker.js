// today.calvin.sg -- the Telegram Mini App's whole server, and the browser/PWA way in beside it.
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
//
// ⚠️ ONE THING NOW QUALIFIES THAT PARAGRAPH, and it is stated rather than left quietly false. With
// an Access application on this hostname, Cloudflare's own `CF_Authorization` cookie is host-scoped
// and therefore reaches this Worker on EVERY request, including the public `GET /`. It is not
// training data, but it is replayable to /web/signin for the life of an Access session. The app's
// cookie-path attribute is what scopes it away from `/` and `/s`; see the plan. `observability`
// stays off in wrangler.jsonc partly for this reason -- the cheapest way to never log a credential
// is to log nothing.

import { validateInitData } from "./initdata.js";
import { verifyAccessJwt } from "./access.js";
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  clearSessionCookieHeader,
  mintSession,
  readCookie,
  sessionCookieHeader,
  shouldRenew,
  verifySession,
} from "./session.js";
import { buildView } from "./view.js";
import APP_HTML from "./app.html";
import ICON_180 from "./icon-180.png";
import ICON_192 from "./icon-192.png";
import ICON_512 from "./icon-512.png";

const KV_KEY = "week:current";
const MAX_INITDATA_AGE_SECONDS = 900; // 15 minutes. A captured launch is useless after that.

// The installed app's name. NOT the <title>, which test/worker.http.test.mjs pins to "Today" --
// and which would be the wrong place anyway, because iOS reads the home-screen label from here.
// `short_name` is what appears under the icon, and iOS truncates that at roughly 12 characters.
const APP_NAME = "My training plan";
const APP_SHORT_NAME = "My plan";
// The splash ground. ⚠️ This is the ONE place a palette value is restated outside app.html's three
// blocks, because a manifest cannot read a CSS token. A test asserts it still equals block 1's
// --background, so the two cannot drift silently. `theme_color` is deliberately ABSENT: the status
// bar is set from the resolved token at runtime, which is right in all three theme states, and a
// literal here would be wrong in two of them.
const SPLASH_BACKGROUND = "#fafafa";

function nonce() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[^A-Za-z0-9]/g, "");
}

function securityHeaders(n, web = false) {
  return {
    // 'none' by default, then exactly what each page needs. The nonce means no 'unsafe-inline'
    // anywhere, which is the difference between a CSP and a decoration.
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${n}'`,
      `style-src 'nonce-${n}'`,
      "connect-src 'self'",
      // The installable document needs its manifest and its icons; the Telegram one needs neither,
      // and is left exactly as it was. 'self' only -- no scheme, no host, no data:.
      ...(web ? ["img-src 'self'", "manifest-src 'self'"] : []),
      "base-uri 'none'",
      "form-action 'none'",
      // Telegram Desktop and the web client run a Mini App in an iframe on web.telegram.org;
      // the mobile clients use a native webview, where this header does not apply.
      // ⚠️ The web document is cookie-authenticated and is NOT a Mini App, so it declares no frame
      // parent at all. Carrying Telegram's origin onto it would make an authenticated page
      // framable by a third party for no reason.
      web ? "frame-ancestors 'none'" : "frame-ancestors https://web.telegram.org",
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

function notFound() {
  return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}

function html(body, n, status = 200, web = false, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...securityHeaders(n, web), ...extra },
  });
}

function json(body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

async function week(env) {
  try {
    return await env.WEEK.get(KV_KEY, { type: "json" });
  } catch {
    return null; // buildView renders "no plan published" honestly rather than blank.
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Fail CLOSED on missing configuration. A Worker deployed without its secrets must refuse
    // everyone, not serve everyone -- an unset ALLOWED_USER_ID that read as "no restriction"
    // would make the app public on the day someone forgot a `wrangler secret put`.
    const configured = typeof env.BOT_TOKEN === "string" && env.BOT_TOKEN.length > 0
      && typeof env.ALLOWED_USER_ID === "string" && /^\d+$/.test(env.ALLOWED_USER_ID);

    // 🔴 A SEPARATE PREDICATE, AND THE SEPARATION IS LOAD-BEARING. The web secrets gate /web/* and
    // NOTHING ELSE. Folding them into `configured` would mean every existing clone and worktree --
    // whose .dev.vars predates them -- fails the TELEGRAM happy path with `401 !== 200`, which
    // CLAUDE.md's trap 1 records as reading exactly like an access-control regression and sending
    // the reader into initdata.js instead of at the missing line.
    const configuredWeb = typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32
      && typeof env.ALLOWED_EMAIL === "string" && env.ALLOWED_EMAIL.length > 0
      && typeof env.ACCESS_AUD === "string" && /^[0-9a-f]{64}$/.test(env.ACCESS_AUD)
      && typeof env.ACCESS_TEAM_DOMAIN === "string" && env.ACCESS_TEAM_DOMAIN.length > 0;

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

      // JSON, not a page. The document is already loaded and already has its nonce; this
      // request exists only to carry the week across the authentication boundary.
      // ⚠️ ADDED BESIDE THE VIEW, NOT INSIDE buildView. The view is a pure function of the
      // published week; which screen to open on is a fact about THIS LAUNCH and belongs to the
      // response, not to the plan. Merging it into buildView would make the same week render
      // two different shapes and every view assertion depend on a launch.
      return json({ ...buildView(await week(env), Date.now()), startParam: result.startParam });
    }

    // ── the browser and home-screen way in ──────────────────────────────────────────────────
    //
    // Access gates EXACTLY ONE path, /web/signin. Everything else here is gated by this Worker's
    // own cookie. That split is the whole design: a home-screen app that had to re-enter Access on
    // a cold start would be sent to another origin with no address bar and no way back.

    // Public, and deliberately so. A manifest fetch does not reliably carry cookies and iOS asks
    // for touch icons from browser chrome; putting either behind auth breaks installation and
    // protects nothing, because they are a name and a picture.
    if (request.method === "GET" && url.pathname === "/web/app.webmanifest") {
      return new Response(JSON.stringify({
        name: APP_NAME,
        short_name: APP_SHORT_NAME,
        start_url: "/web/",
        // ⚠️ SCOPE MUST BE EXPLICIT. Omitting it does not default usefully on iOS -- it makes every
        // link open in Safari, which for a standalone app means it stops being one.
        scope: "/web/",
        display: "standalone",
        background_color: SPLASH_BACKGROUND,
        icons: [
          { src: "/web/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/web/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        ],
      }), {
        headers: {
          "Content-Type": "application/manifest+json; charset=utf-8",
          // NOT `no-store`. iOS fetches the manifest when the Share sheet opens rather than at page
          // load, and a racing or refused fetch is a documented cause of installing a plain Safari
          // bookmark instead of a standalone app -- which fails silently, because the icon appears
          // either way.
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/web/icon-")) {
      const icon = url.pathname === "/web/icon-180.png" ? ICON_180
        : url.pathname === "/web/icon-192.png" ? ICON_192
        : url.pathname === "/web/icon-512.png" ? ICON_512
        : null;
      if (!icon) return notFound();
      return new Response(icon, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    // THE ONLY ACCESS-GATED PATH.
    //
    // ⚠️ MATCHED EXACTLY, never with startsWith. The Access application is registered for this
    // precise URL with no wildcard, and Cloudflare does not strip `Cf-` request headers on paths no
    // application covers -- so `/web/signin/x` would arrive here carrying a CLIENT-SUPPLIED
    // assertion header. The Worker verifying the token itself is what makes that harmless, which is
    // an argument for that verification being airtight rather than for relaxing this.
    if (url.pathname === "/web/signin") {
      if (request.method !== "GET") return deny();
      if (!configuredWeb) return deny();

      const token = request.headers.get("Cf-Access-Jwt-Assertion");
      const verified = await verifyAccessJwt(token ?? "", {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        aud: env.ACCESS_AUD,
        nowMs: Date.now(),
        certsUrl: env.ACCESS_CERTS_URL, // undefined in production; the suite points it at a local JWKS
      });
      if (!verified.ok) return deny();

      // THE ACCESS CONTROL, and it is a SECOND gate rather than a restatement of the first.
      // Cloudflare already refused everyone else at the edge -- but if this application were ever
      // deleted from the dashboard, a Worker that trusted the perimeter would start handing
      // 30-day sessions to the internet. Same shape as the user-id line above, same reason.
      if (verified.email !== env.ALLOWED_EMAIL) return deny();

      const value = await mintSession(verified.email, { secret: env.SESSION_SECRET });
      return new Response(null, {
        status: 302,
        headers: {
          // A STRING LITERAL, never a redirect target taken from the request. Access appends its own
          // `redirect_url` to these flows and honouring it would make an authenticated open redirect
          // on this hostname, which `form-action 'none'` does not cover.
          "Location": "/web/",
          "Set-Cookie": sessionCookieHeader(value, Math.floor(SESSION_TTL_MS / 1000)),
          "Cache-Control": "no-store",
        },
      });
    }

    // A convenience so a typed or shared `/web` reaches the app rather than a 404. Same-origin,
    // literal target.
    if (request.method === "GET" && url.pathname === "/web") {
      return new Response(null, { status: 302, headers: { "Location": "/web/", "Cache-Control": "no-store" } });
    }

    // 🔴 ALWAYS 200, IN EVERY AUTHENTICATION STATE, AND NEVER A REDIRECT.
    //
    // This is the home-screen app's start_url. A standalone web app has no address bar, no reload
    // and no back button, so whatever this returns IS the app. Answering a missing cookie with a
    // redirect to /web/signin would hand the launch itself to Access and then to another origin,
    // before any user gesture -- and the reader would be looking at a blank shell or a chrome-less
    // error with no way out. So: the same document, carrying NO TRAINING DATA, and the client draws
    // a sign-in link that the reader taps. The navigation is always theirs, never ours.
    if (request.method === "GET" && url.pathname === "/web/") {
      const n = nonce();
      // Byte-identical to `GET /`. The only per-request substitution in this document is the nonce,
      // and it must stay that way: ci.yml and drift.yml both prove the deploy by hashing
      // `sed 's/__NONCE__/N/g' src/app.html` against the live page normalised on the nonce alone,
      // so a SECOND template token would make those digests disagree for ever. Which route this is
      // gets derived on the client from location.pathname.
      return html(APP_HTML.replaceAll("__NONCE__", n), n, 200, true);
    }

    if (url.pathname === "/web/s") {
      if (request.method !== "POST") return deny();
      if (!configuredWeb) return deny();

      const cookie = readCookie(request.headers.get("cookie"), COOKIE_NAME);
      if (!cookie) return deny();
      const nowMs = Date.now();
      const session = await verifySession(cookie, { secret: env.SESSION_SECRET, nowMs });
      if (!session.ok) return deny();

      // 🔴 THE AUTHORISATION LINE, ON EVERY REQUEST -- not once at sign-in.
      //
      // An earlier draft checked the email only when minting, which meant the cookie WAS the
      // authorisation rather than a pointer to it: changing ALLOWED_EMAIL or deleting the Access
      // policy would have revoked nothing for thirty days. This is trap 5 in its second costume,
      // and the suite mints a validly-signed cookie for the wrong address to prove the line exists.
      if (session.email !== env.ALLOWED_EMAIL) return deny();

      // Sliding renewal, ON THE DATA REQUEST as well as the document. Nothing re-requests the
      // document in a long-lived home-screen app, so renewing only there would never fire and the
      // session would die on the hard ceiling with no warning.
      const extra = {};
      if (shouldRenew(session, nowMs)) {
        const value = await mintSession(session.email, {
          secret: env.SESSION_SECRET,
          nowMs,
          iatMs: session.iatMs, // the ceiling is anchored to FIRST sign-in and never moves
        });
        extra["Set-Cookie"] = sessionCookieHeader(value, Math.floor(SESSION_TTL_MS / 1000));
      }

      return json(buildView(await week(env), nowMs), extra);
    }

    // Signing out is a first-party same-origin action. It cannot reach into Cloudflare's own
    // session, so it clears ours and says so honestly rather than pretending to do more.
    if (request.method === "POST" && url.pathname === "/web/signout") {
      return new Response(null, {
        status: 302,
        headers: { "Location": "/web/", "Set-Cookie": clearSessionCookieHeader(), "Cache-Control": "no-store" },
      });
    }

    // Everything else, including HEAD and any probe for a data file, gets nothing.
    return notFound();
  },
};
