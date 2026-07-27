#!/usr/bin/env node
// End-to-end smoke test for the firewalled OIDC topology:
//
//   mock RP (in-process, this script) <--Auth Code + PKCE--> façade :3002 <--proxy--> API :4001 (private)
//
// The "browser" in this script (the cookie-jar driver below) talks ONLY to the public façade
// (:3002) and to its own in-process RP — it NEVER contacts the private API (:4001) directly.
// This mirrors the real production topology, where :4001 is firewalled from the public internet
// and the façade is the only public surface.
//
// CSRF: the façade's sign-in forms are protected by @hapi/crumb (double-submit cookie). The
// driver therefore behaves like a real browser: it GETs the sign-in page first (absorbing the
// crumb cookie), scrapes the crumb token out of the page's hidden `crumb` input, and submits it
// alongside each form POST. The pass-through OIDC endpoints (/auth, /token, ...) are crumb-exempt.
//
// OTP code retrieval: the façade's /ui/interaction/{uid}/email handler calls the API's
// /otp/request server-to-server and does NOT return the code to the browser (by design — the
// code is only ever meant to reach the citizen's inbox via GOV.UK Notify; there is no dev
// backdoor). Supply the code received by email via SMOKE_OTP_CODE. Run it, e.g., as:
//
//   # terminal 1 (API, private)
//   cd forms-identity-api && OIDC_JWKS=... OIDC_COOKIE_KEYS=... MONGO_URI=... PORT=4001 npm run dev
//
//   # terminal 2 (façade, public)
//   cd forms-identity-ui && PORT=3002 IDENTITY_API_URL=http://localhost:4001 npm run dev
//
//   # terminal 3
//   SMOKE_EMAIL=you@example.com node scripts/smoke.mjs   # then, once the email arrives:
//   SMOKE_EMAIL=you@example.com SMOKE_OTP_CODE=123456 node scripts/smoke.mjs
import assert from 'node:assert'
import crypto from 'node:crypto'
import http from 'node:http'

const ISSUER = process.env.ISSUER ?? 'http://localhost:3002'
const PRIVATE_HOST = 'localhost:4001' // must NEVER be contacted by the driver below
// Must match the API's registered `runner` client redirect_uri (OIDC_RUNNER_REDIRECT_URIS,
// default http://localhost:3000/callback) or the provider rejects the /auth request up front.
const RP_PORT = Number(process.env.RP_PORT ?? 3000)
const RP = `http://localhost:${RP_PORT}`
const EMAIL = process.env.SMOKE_EMAIL ?? `smoke-${Date.now()}@example.com`

// ---- tiny in-process mock relying party (stands in for forms-runner) ----
/** @type {Map<string, string>} state -> pkce verifier */
const pending = new Map()

/** @type {Record<string, string> | undefined} */
let discovery

async function disco() {
  if (!discovery) {
    // The façade's proxy derives x-forwarded-proto/host from the configured public
    // issuer (config `oidc.issuer`), not from the inbound client Host, so discovery
    // correctly advertises http:// endpoints for a local http:// issuer — no
    // scheme rewrite needed here.
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`)
    discovery = /** @type {Record<string, string>} */ (await res.json())
  }
  return discovery
}

const rp = http.createServer((request, res) => {
  handleRp(request, res).catch((err) => {
    res.writeHead(500)
    res.end(String(err))
  })
})

/**
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} res
 */
async function handleRp(request, res) {
  const url = new URL(request.url ?? '/', RP)
  if (url.pathname === '/login') {
    const d = await disco()
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest()
      .toString('base64url')
    const state = crypto.randomBytes(8).toString('base64url')
    pending.set(state, verifier)
    const authUrl =
      `${d.authorization_endpoint}?` +
      String(
        new URLSearchParams({
          client_id: 'runner',
          response_type: 'code',
          scope: 'openid email',
          redirect_uri: `${RP}/callback`,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256'
        })
      )
    res.writeHead(302, { Location: authUrl })
    res.end()
    return
  }
  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    if (error) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error }))
      return
    }
    const verifier = state ? pending.get(state) : undefined
    const d = await disco()
    const tokenRes = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        redirect_uri: `${RP}/callback`,
        client_id: 'runner',
        code_verifier: verifier ?? ''
      })
    })
    const tokens = await tokenRes.json()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(tokens))
    return
  }
  res.writeHead(404)
  res.end()
}

await new Promise((resolve) => rp.listen(RP_PORT, () => resolve(undefined)))

// ---- cookie-jar driver (plays the browser) ----
/** @type {Map<string, string>} */
const jar = new Map()

/**
 * @param {Response} res
 */
function absorb(res) {
  for (const c of res.headers.getSetCookie()) {
    const p = c.split(';')[0]
    const i = p.indexOf('=')
    const n = p.slice(0, i).trim()
    const v = p.slice(i + 1).trim()
    if (v === '') {
      jar.delete(n)
    } else {
      jar.set(n, v)
    }
  }
}

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [opts]
 */
async function req(url, opts = {}) {
  assert.ok(
    !url.includes(PRIVATE_HOST),
    `browser must never touch the private API, but tried: ${url}`
  )
  const res = await fetch(url, {
    redirect: 'manual',
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      ...(jar.size ? { cookie: cookieHeader() } : {})
    }
  })
  absorb(res)
  return res
}

/**
 * @param {string} url
 * @param {{ stopBefore?: string }} [options]
 */
async function follow(url, { stopBefore } = {}) {
  for (let i = 0; i < 15; i++) {
    if (stopBefore && url.startsWith(stopBefore)) {
      return { kind: 'stopped', url, res: undefined }
    }
    const res = await req(url)
    if (res.status >= 300 && res.status < 400) {
      url = new URL(res.headers.get('location') ?? '', url).toString()
      continue
    }
    return { kind: 'page', url, res }
  }
  throw new Error('too many redirects')
}

/**
 * Scrape the crumb token from a rendered sign-in page's hidden input, exactly
 * as a browser would submit it back
 * @param {string} html
 */
function scrapeCrumb(html) {
  const match = /name="crumb" value="([^"]*)"/.exec(html)
  assert.ok(match?.[1], 'expected a hidden crumb input on the page')
  return match[1]
}

try {
  // 0. Discovery must be served through the façade, advertising itself as the issuer.
  const d = await disco()
  assert.equal(d.issuer, ISSUER, 'issuer must be the public façade')
  console.log(`0. discovery ok via façade; issuer=${d.issuer}`)

  // 1. RP -> façade /auth (Authorization Code + PKCE) -> façade sign-in UI.
  const step = await follow(`${RP}/login`)
  assert.ok(
    step.url.startsWith(`${ISSUER}/ui/interaction/`),
    `expected façade sign-in UI, got ${step.url}`
  )
  const uid = step.url.split('/ui/interaction/')[1].split('?')[0]
  assert.ok(step.res, 'expected the sign-in page response')
  const emailCrumb = scrapeCrumb(await step.res.text())
  console.log(`1. redirected to façade sign-in UI; uid=${uid} (crumb absorbed)`)

  // 2. Submit email (+ crumb) on the façade UI. The façade calls the API's
  //    /otp/request server-to-server; the code is never sent to the browser.
  const verifyPage = await req(`${ISSUER}/ui/interaction/${uid}/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ crumb: emailCrumb, email: EMAIL }).toString()
  })
  assert.equal(
    verifyPage.status,
    200,
    `expected the verify page after submitting the email, got ${verifyPage.status}`
  )
  const verifyCrumb = scrapeCrumb(await verifyPage.text())
  // Recover the code. Delivery is real GOV.UK Notify in EVERY environment
  // (prod === local) — there is no dev backdoor and no devCode. The code only
  // reaches the citizen's inbox. Two ways to drive this smoke:
  //   • manual:    read the code from the email and pass SMOKE_OTP_CODE=nnnnnn
  //   • automated: (not yet wired) pull it from the Notify API with the same key
  // Until the proof mechanism is chosen, require the code be supplied explicitly.
  const code = process.env.SMOKE_OTP_CODE
  assert.ok(
    code,
    'No SMOKE_OTP_CODE set. Real Notify delivers the code by email in all ' +
      'environments; supply the received code via SMOKE_OTP_CODE, or wire Notify-API ' +
      'retrieval into this smoke.'
  )
  console.log(`2. email submitted via Notify; using supplied code: ${code}`)

  // 3. Post the code (+ crumb) to the façade's crumb-protected complete route,
  //    which forwards it through the proxy to the API's atomic verify+complete
  //    endpoint. A valid code both verifies AND establishes the session in one
  //    request; there is no separate "complete" step to reach without a code.
  //    The response is the provider's resume redirect.
  const complete = await req(`${ISSUER}/interaction/${uid}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      crumb: verifyCrumb,
      email: EMAIL,
      code
    }).toString()
  })
  assert.ok(
    complete.status >= 300 && complete.status < 400,
    `a valid code should complete + redirect into the flow, got ${complete.status}`
  )
  const resumeUrl = new URL(
    complete.headers.get('location') ?? '',
    ISSUER
  ).toString()
  console.log(
    `3. code verified + interaction completed atomically; resuming at ${resumeUrl}`
  )

  // 4. Follow the resume redirect (façade -> API) -> consent auto-grant -> RP /callback.
  const done = await follow(resumeUrl, { stopBefore: `${RP}/callback` })
  assert.equal(
    done.kind,
    'stopped',
    `expected to reach RP callback, got ${done.url}`
  )
  const tokens = JSON.parse(await (await req(done.url)).text())
  assert.ok(tokens.id_token, `token exchange failed: ${JSON.stringify(tokens)}`)
  const claims = JSON.parse(
    Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString()
  )
  assert.equal(
    claims.iss,
    ISSUER,
    `id_token iss must be the public façade, got ${claims.iss}`
  )
  console.log(
    `4. RP exchanged the code for tokens; id_token iss=${claims.iss} sub=${claims.sub}`
  )

  console.log(
    '\nSMOKE PASSED (firewalled topology)\n' +
      '   The browser-side driver above talked only to the façade (:3002) and its own in-process\n' +
      '   RP; it never contacted the private API (:4001) directly (enforced by an assertion on\n' +
      '   every request). Discovery, sign-in UI, CSRF crumbs, OTP verification, token exchange\n' +
      '   and the id_token issuer all round-tripped through the façade.'
  )
} finally {
  rp.close()
}
