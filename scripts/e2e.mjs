/**
 * Local end-to-end driver for the DF-1160 JIT sign-in journey. Plays the RP
 * (as forms-runner will) against the running dev servers:
 *
 *   forms-identity-api:  npm run dev   (:3010, needs its docker mongo)
 *   forms-identity-ui:   npm run dev   (:3011)
 *
 * Then: node scripts/e2e.mjs
 *
 * The browser-side traffic only ever touches the UI (:3011). The API is
 * touched directly ONLY to capture the one-time code: with a dummy Notify
 * key the email send fails loudly (as designed), so after requesting a code
 * the driver overwrites the stored otps record with the argon2 hash of a
 * known code. With a real NOTIFY_API_KEY the same driver works unchanged —
 * the overwrite simply replaces a deliverable code.
 *
 * Requires the UI .env to include the driver's callback in
 * OIDC_RUNNER_REDIRECT_URIS (http://localhost:3902/callback) and the
 * OIDC_CLIENT_SECRET used by the provider.
 */
import assert from 'node:assert'
import crypto from 'node:crypto'
import http from 'node:http'
import { createRequire } from 'node:module'

import 'dotenv/config'

// argon2/mongodb live in the API repo — resolve them from its node_modules
const apiRequire = createRequire(
  new URL('../../forms-identity-api/package.json', import.meta.url)
)
const argon2 = apiRequire('argon2')
const { MongoClient } = apiRequire('mongodb')

const ISSUER = 'http://localhost:3011'
const API_HOST = 'localhost:3010'
const RP_PORT = Number(process.env.E2E_RP_PORT ?? 3902)
const RP = `http://localhost:${RP_PORT}`
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET
const MONGO_URI =
  'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true'
const KNOWN_CODE = '123456'
const PURPOSE = 'SIGNIN_VERIFY_EMAIL'
const PHONE = '07911 123456'

assert.ok(CLIENT_SECRET, 'OIDC_CLIENT_SECRET must be set (UI .env)')

let discovery
async function disco() {
  discovery ??= await (
    await fetch(`${ISSUER}/.well-known/openid-configuration`)
  ).json()
  return discovery
}

const pending = new Map()

const rp = http.createServer((request, res) => {
  const url = new URL(request.url ?? '/', RP)
  if (url.pathname === '/login') {
    disco()
      .then((d) => {
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
      })
      .catch((err) => {
        res.writeHead(500)
        res.end(String(err))
      })
    return
  }
  if (url.pathname === '/callback') {
    // The driver reads the code itself via redirect:'manual'; serve a marker
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('callback')
    return
  }
  res.writeHead(404)
  res.end()
})
rp.on('error', (err) => {
  // e.g. EADDRINUSE — without this the driver would silently talk to
  // whatever else is on the port (like the example RP under npm run dev)
  console.error(err)
  process.exit(1)
})
await new Promise((resolve) => {
  rp.listen(RP_PORT, () => {
    resolve(undefined)
  })
})

/** @type {Map<string, string>} */
const jar = new Map()
/** @param {Response} res */
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
 * @param {{ method?: string, headers?: Record<string, string>, body?: URLSearchParams }} [opts]
 */
async function req(url, opts = {}) {
  assert.ok(!url.includes(API_HOST), `browser touched the private API: ${url}`)
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
      return { kind: 'stopped', url }
    }
    const res = await req(url)
    if (res.status >= 300 && res.status < 400) {
      url = new URL(String(res.headers.get('location')), url).toString()
      continue
    }
    return { kind: 'page', url, res }
  }
  throw new Error('too many redirects')
}

/** @param {string} html */
const crumbFrom = (html) =>
  /name="crumb" value="([^"]+)"/.exec(html)?.[1] ??
  assert.fail('no crumb field found in page')

/**
 * Requests a code for the email, then swaps in the known-code hash
 * @param {string} uid
 * @param {string} email
 * @param {string} crumb
 */
async function requestAndCaptureCode(uid, email, crumb) {
  const emailRes = await req(`${ISSUER}/interaction/${uid}/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, crumb })
  })
  // 302 = Notify accepted (real key); 4xx/5xx = Notify rejected the dummy
  // key AFTER the otps record was stored (its status propagates through the
  // Boom chain, e.g. 403 for an invalid token) — tolerated for this step only
  assert.ok(
    emailRes.status === 302 || emailRes.status >= 400,
    `email POST: expected 302 or an error status, got ${emailRes.status}`
  )

  const mongo = await MongoClient.connect(MONGO_URI)
  const coll = mongo.db('forms-identity-api').collection('otps')
  const stored = await coll.findOne({ uid, purpose: PURPOSE })
  assert.ok(stored, 'otps record must exist (stored before the Notify call)')
  assert.equal(stored.target, email.toLowerCase())
  assert.ok(stored.codeHash?.startsWith('$argon2'), 'code must be hashed')
  await coll.updateOne(
    { uid, purpose: PURPOSE },
    {
      $set: {
        codeHash: await argon2.hash(KNOWN_CODE),
        expireAt: new Date(Date.now() + 900_000),
        attempts: 0,
        verified: false,
        consumed: false
      }
    }
  )
  await mongo.close()
  return `/interaction/${uid}/code?email=${encodeURIComponent(email)}`
}

/**
 * @param {string} callbackUrl
 * @param {{ auth?: boolean }} [options]
 */
async function exchangeCode(callbackUrl, { auth = true } = {}) {
  const url = new URL(callbackUrl)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  assert.ok(code, `no code on callback: ${callbackUrl}`)
  const d = await disco()
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (auth) {
    headers.authorization =
      'Basic ' + Buffer.from(`runner:${CLIENT_SECRET}`).toString('base64')
  }
  return fetch(d.token_endpoint, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${RP}/callback`,
      code_verifier: String(pending.get(state)),
      ...(auth ? {} : { client_id: 'runner' })
    })
  })
}

try {
  const EMAIL = `e2e-${Date.now()}@example.com`

  // 0. Discovery
  const d = await disco()
  assert.equal(d.issuer, ISSUER)
  assert.ok(d.authorization_endpoint.startsWith(ISSUER))
  console.log(`0. discovery ok; issuer=${d.issuer}`)

  // 1. /auth → interaction email page
  const step = await follow(`${RP}/login`)
  assert.ok(step.url.startsWith(`${ISSUER}/interaction/`), step.url)
  const uid = step.url.split('/interaction/')[1].split('?')[0].split('/')[0]
  assert.ok(step.kind === 'page' && step.res, 'expected the sign-in page')
  const crumb = crumbFrom(await step.res.text())
  console.log(`1. sign-in UI reached; uid=${uid}`)

  // 2. email → code page (+ code capture)
  await requestAndCaptureCode(uid, EMAIL, crumb)
  console.log('2. code requested; otps record captured and known code set')

  // 3. wrong code → error re-render
  const wrong = await req(`${ISSUER}/interaction/${uid}/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: '000000', email: EMAIL, crumb })
  })
  assert.equal(wrong.status, 200)
  assert.match(await wrong.text(), /There is a problem/)
  console.log('3. wrong code re-rendered with a GDS error')

  // 4. right code → phone page (JIT arm: no account yet)
  const right = await req(`${ISSUER}/interaction/${uid}/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: KNOWN_CODE, email: EMAIL, crumb })
  })
  assert.equal(right.status, 302)
  assert.ok(
    String(right.headers.get('location')).endsWith(`/interaction/${uid}/phone`)
  )
  console.log('4. valid code → phone page (no account exists)')

  // 5. invalid phone → error; valid phone → completion → callback
  const badPhone = await req(`${ISSUER}/interaction/${uid}/phone`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ phone: '020 7946 0000', crumb })
  })
  assert.equal(badPhone.status, 200)
  assert.match(await badPhone.text(), /There is a problem/)

  const goodPhone = await req(`${ISSUER}/interaction/${uid}/phone`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ phone: PHONE, crumb })
  })
  // interactionFinished writes the provider's own 303 See Other redirect
  assert.ok(
    goodPhone.status === 302 || goodPhone.status === 303,
    `expected completion redirect, got ${goodPhone.status}`
  )
  const resume = new URL(
    String(goodPhone.headers.get('location')),
    ISSUER
  ).toString()
  const done = await follow(resume, { stopBefore: `${RP}/callback` })
  assert.equal(done.kind, 'stopped', `expected RP callback, got ${done.url}`)
  console.log('5. landline rejected; valid mobile completed the interaction')

  // 6. token exchange (confidential client) + claims + userinfo
  const tokenRes = await exchangeCode(done.url)
  const tokens = await tokenRes.json()
  assert.ok(tokens.id_token, `token exchange failed: ${JSON.stringify(tokens)}`)
  const claims = JSON.parse(
    Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()
  )
  assert.equal(claims.iss, ISSUER)
  assert.match(
    claims.sub,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'sub must be an opaque UUID, not an email'
  )
  const userinfo = await (
    await req(`${ISSUER}/me`, {
      headers: { authorization: `Bearer ${tokens.access_token}` }
    })
  ).json()
  assert.equal(userinfo.email, EMAIL.toLowerCase())
  assert.equal(userinfo.sub, claims.sub)
  console.log(`6. tokens + userinfo ok; sub=${claims.sub}`)

  // 7. silent SSO on the existing provider session
  const sso = await follow(`${RP}/login`, { stopBefore: `${RP}/callback` })
  assert.equal(sso.kind, 'stopped', `expected silent SSO, got ${sso.url}`)
  console.log('7. silent SSO confirmed')

  // 8. existing-account arm: fresh browser, same email → NO phone page
  jar.clear()
  const step2 = await follow(`${RP}/login`)
  const uid2 = step2.url.split('/interaction/')[1].split('?')[0].split('/')[0]
  assert.ok(step2.kind === 'page' && step2.res, 'expected the sign-in page')
  const crumb2 = crumbFrom(await step2.res.text())
  await requestAndCaptureCode(uid2, EMAIL, crumb2)
  const signin2 = await req(`${ISSUER}/interaction/${uid2}/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: KNOWN_CODE, email: EMAIL, crumb: crumb2 })
  })
  // existing account → interactionFinished directly (provider's 303)
  assert.ok(
    signin2.status === 302 || signin2.status === 303,
    `expected completion redirect, got ${signin2.status}`
  )
  const loc2 = String(signin2.headers.get('location'))
  assert.ok(
    !loc2.includes('/phone'),
    `existing account must skip the phone page, got ${loc2}`
  )
  const done2 = await follow(new URL(loc2, ISSUER).toString(), {
    stopBefore: `${RP}/callback`
  })
  assert.equal(done2.kind, 'stopped', `expected callback, got ${done2.url}`)
  const tokens2 = await (await exchangeCode(done2.url)).json()
  assert.ok(tokens2.id_token, 'second sign-in token exchange failed')
  const claims2 = JSON.parse(
    Buffer.from(tokens2.id_token.split('.')[1], 'base64url').toString()
  )
  assert.equal(claims2.sub, claims.sub, 'same account across sign-ins')
  console.log('8. existing-account arm: no phone page, same sub')

  // 9. CSRF: crumbless POST → 403
  const noCrumb = await req(`${ISSUER}/interaction/${uid2}/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: EMAIL })
  })
  assert.equal(
    noCrumb.status,
    403,
    `crumbless POST must 403, got ${noCrumb.status}`
  )
  console.log('9. crumbless POST rejected with 403')

  // 10. confidential client: token exchange without client auth → 401
  jar.clear()
  const step3 = await follow(`${RP}/login`)
  const uid3 = step3.url.split('/interaction/')[1].split('?')[0].split('/')[0]
  assert.ok(step3.kind === 'page' && step3.res, 'expected the sign-in page')
  const crumb3 = crumbFrom(await step3.res.text())
  await requestAndCaptureCode(uid3, EMAIL, crumb3)
  const signin3 = await req(`${ISSUER}/interaction/${uid3}/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: KNOWN_CODE, email: EMAIL, crumb: crumb3 })
  })
  const done3 = await follow(
    new URL(String(signin3.headers.get('location')), ISSUER).toString(),
    {
      stopBefore: `${RP}/callback`
    }
  )
  const unauth = await exchangeCode(done3.url, { auth: false })
  assert.equal(
    unauth.status,
    401,
    `unauthenticated token exchange must 401, got ${unauth.status}`
  )
  console.log('10. token exchange without the client secret rejected with 401')

  console.log(
    '\n✅ E2E PASSED — JIT sign-in, both arms, SSO, CSRF and client auth'
  )
} finally {
  rp.close()
}
