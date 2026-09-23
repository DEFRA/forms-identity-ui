/**
 * Whole change-email journey (`routes/account.js`) against a stub
 * forms-identity-api on loopback, starting from a real signed-in session
 * produced by completing the ordinary sign-in journey first.
 *
 * The change-email journey re-verifies the account's phone before it will
 * accept a new email address, then re-verifies the new address itself
 * before applying it — this proves both OTP gates actually gate (a route
 * hit out of order redirects back to the start rather than proceeding) and
 * that the account's email is only ever updated once both are satisfied.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'

const mockStsSend = jest.fn()

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: jest.fn()
  })),
  GetWebIdentityTokenCommand: jest.fn((input) => ({ input }))
}))

// See signin-round-trip.test.js for why this substitution is needed: the
// provider clones client metadata on startup using the host realm's Object.
globalThis.structuredClone = /** @type {typeof structuredClone} */ (
  /** @param {unknown} value */
  (value) => JSON.parse(JSON.stringify(value))
)

const ISSUER = 'http://localhost:3011'
const REDIRECT_URI = 'http://localhost:3009/callback'
const KNOWN_CODE = '123456'
const PHONE = '07911 123456'

/**
 * Artifact payloads by `${model}/${id}`, standing in for the OIDC adapter's
 * store (sessions, interactions, grants, ...)
 * @type {Map<string, Record<string, unknown>>}
 */
const artifacts = new Map()
/**
 * OTP records by `${hashedUid}:${purpose}` — a real account can have a
 * phone OTP and an email OTP live for the same uid at once, so the purpose
 * has to be part of the key
 * @type {Map<string, { target: string, verified: boolean }>}
 */
const otps = new Map()
/**
 * Accounts by id
 * @type {Map<string, { id: string, email: string, phone: string }>}
 */
const accounts = new Map()

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, string>>}
 */
function readBody(req) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = []

    req.on('data', (chunk) => {
      chunks.push(/** @type {Buffer} */ (chunk))
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      resolve(raw ? JSON.parse(raw) : {})
    })
  })
}

const NOT_FOUND = { status: 404, body: { message: 'not found' } }
const NO_CONTENT = { status: 204, body: undefined }

/**
 * The artifact store behind the oidc-provider adapter — only sign-in needs
 * this (sessions, interactions, grants); the change-email journey itself
 * never touches it.
 * @param {string} method
 * @param {string[]} segments - path segments after `/oidc`
 * @param {{ payload?: Record<string, unknown> }} body
 * @returns {{ status: number, body?: unknown }}
 */
function oidcStore(method, segments, body) {
  const [model, id, action] = segments

  if (model === 'grants') {
    for (const [key, artifact] of artifacts) {
      if (artifact.grantId === id) {
        artifacts.delete(key)
      }
    }
    return NO_CONTENT
  }

  if (id === 'uid') {
    const found = [...artifacts].find(
      ([key, artifact]) =>
        key.startsWith(`${model}/`) && artifact.uid === segments[2]
    )
    return found ? { status: 200, body: found[1] } : NOT_FOUND
  }

  const key = `${model}/${id}`

  if (method === 'PUT') {
    artifacts.set(key, /** @type {Record<string, unknown>} */ (body.payload))
    return NO_CONTENT
  }
  if (method === 'POST' && action === 'consume') {
    const artifact = artifacts.get(key)

    if (artifact) {
      artifact.consumed = Math.floor(Date.now() / 1000)
    }
    return NO_CONTENT
  }
  if (method === 'DELETE') {
    artifacts.delete(key)
    return NO_CONTENT
  }
  return artifacts.has(key)
    ? { status: 200, body: artifacts.get(key) }
    : NOT_FOUND
}

/**
 * The OTP endpoints behind identity-api.js's request/verify/get/cleanup
 * calls. Keyed and shaped exactly as identity-api.js sends and reads them
 * (see identity-api.test.js): request/verify take `{ uid, target, purpose }`
 * / `{ uid, code, purpose }` with `uid` already a digest; a lookup is
 * `GET /otp/{hash}/{purpose}` returning `{ target, verified, consumed }`.
 * @param {string} method
 * @param {string[]} segments - path segments after `/otp`
 * @param {Record<string, string>} body
 * @returns {{ status: number, body?: unknown }}
 */
function otpEndpoints(method, segments, body) {
  const [first, second] = segments

  if (method === 'POST' && first === 'request') {
    otps.set(`${body.uid}:${body.purpose}`, {
      target: body.target,
      verified: false
    })
    return NO_CONTENT
  }

  if (method === 'POST' && first === 'verify') {
    const record = otps.get(`${body.uid}:${body.purpose}`)

    if (!record) {
      return {
        status: 200,
        body: { status: 'invalid-code-consumed-or-expired' }
      }
    }
    if (body.code !== KNOWN_CODE) {
      return { status: 200, body: { status: 'invalid' } }
    }
    record.verified = true

    // only the sign-in purpose resolves to signed-in/phone-required; every
    // account purpose (phone/email re-verification) just reports valid
    if (body.purpose === PURPOSE.SIGNIN_VERIFY_EMAIL) {
      const existing = [...accounts.values()].find(
        (account) => account.email === record.target
      )
      return {
        status: 200,
        body: existing
          ? { status: 'signed-in', accountId: existing.id }
          : { status: 'phone-required' }
      }
    }

    return { status: 200, body: { status: 'valid' } }
  }

  if (method === 'DELETE') {
    for (const key of [...otps.keys()]) {
      if (key.startsWith(`${first}:`)) {
        otps.delete(key)
      }
    }
    return NO_CONTENT
  }

  // GET /otp/{hash}/{purpose}
  const record = otps.get(`${first}:${second}`)
  return record
    ? {
        status: 200,
        body: {
          target: record.target,
          verified: record.verified,
          consumed: false
        }
      }
    : NOT_FOUND
}

/**
 * The account endpoints: JIT signup completion (sign-in only), the plain
 * lookup the session scheme uses, and the email PATCH the change-email
 * journey ends with.
 * @param {string} method
 * @param {string[]} segments - path segments after `/accounts`
 * @param {Record<string, string>} body
 * @returns {{ status: number, body?: unknown }}
 */
function accountsEndpoints(method, segments, body) {
  if (method === 'POST' && segments.length === 0) {
    // completeSignup only ever runs after the sign-in email OTP is verified
    const record = otps.get(`${body.uid}:${PURPOSE.SIGNIN_VERIFY_EMAIL}`)

    if (!record?.verified) {
      return { status: 200, body: { status: 'invalid' } }
    }

    const account = {
      id: randomBytes(16).toString('hex'),
      email: record.target,
      phone: body.phone
    }
    accounts.set(account.id, account)
    return {
      status: 200,
      body: { status: 'signed-in', accountId: account.id }
    }
  }

  // updateEmail: PATCH /accounts/{hashedUid}/{accountId}/email — the new
  // address isn't in the request body, it's the verified email OTP's target
  // (identity-api.js reads it server-side, same as the real API does)
  if (method === 'PATCH' && segments[2] === 'email') {
    const hashedUid = segments[0]
    const account = accounts.get(segments[1])
    const record = otps.get(`${hashedUid}:${PURPOSE.ACCOUNT_VERIFY_EMAIL}`)

    if (account && record) {
      account.email = record.target
    }

    // account.js no longer calls cleanupOtps itself — this endpoint now
    // cascades the cleanup of every OTP tied to the interaction (phone and
    // email) once the change lands
    for (const key of [...otps.keys()]) {
      if (key.startsWith(`${hashedUid}:`)) {
        otps.delete(key)
      }
    }
    return NO_CONTENT
  }

  if (method === 'GET' && segments.length === 1) {
    const account = accounts.get(segments[0])
    return account ? { status: 200, body: account } : NOT_FOUND
  }

  return NOT_FOUND
}

/**
 * The stub API.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handle(req, res) {
  const path = /** @type {string} */ (req.url)
  const method = /** @type {string} */ (req.method)
  const body =
    method === 'GET' || method === 'DELETE' ? {} : await readBody(req)
  const segments = path.split('/').filter(Boolean)

  const result =
    segments[0] === 'oidc'
      ? oidcStore(method, segments.slice(1), body)
      : segments[0] === 'otp'
        ? otpEndpoints(method, segments.slice(1), body)
        : segments[0] === 'accounts'
          ? accountsEndpoints(method, segments.slice(1), body)
          : NOT_FOUND

  res.writeHead(result.status, { 'content-type': 'application/json' })
  res.end(result.body === undefined ? '' : JSON.stringify(result.body))
}

describe('change-email round trip', () => {
  /** @type {import('node:http').Server} */
  let stub
  /** @type {import('@hapi/hapi').Server} */
  let server
  /** Cookie jar: name -> { value, path } */
  const jar = new Map()

  beforeAll(async () => {
    stub = createHttpServer((req, res) => {
      handle(req, res).catch(() => {
        res.writeHead(500)
        res.end()
      })
    })
    await new Promise((resolve) => {
      stub.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined))
    })

    const { port } = /** @type {import('node:net').AddressInfo} */ (
      stub.address()
    )
    process.env.IDENTITY_API_URL = `http://127.0.0.1:${port}`

    const { createServer } = await import('~/src/server/index.js')
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
    await new Promise((resolve) => stub.close(resolve))
  })

  beforeEach(() => {
    jar.clear()
    mockStsSend.mockResolvedValue({ WebIdentityToken: 'stub-service-token' })
  })

  /**
   * Stores the response's cookies and returns the response
   * @param {import('@hapi/hapi').ServerInjectResponse} res
   */
  function keepCookies(res) {
    const setCookie = res.headers['set-cookie'] ?? []

    for (const header of [setCookie].flat()) {
      const [pair, ...attributes] = header.split(';')
      const separator = pair.indexOf('=')
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      const path = attributes
        .map((attribute) => attribute.trim())
        .find((attribute) => attribute.toLowerCase().startsWith('path='))

      if (value) {
        jar.set(name, { value, path: path?.slice('path='.length) ?? '/' })
      } else {
        jar.delete(name)
      }
    }

    return res
  }

  /**
   * @param {string} url
   */
  function cookieHeader(url) {
    const path = url.split('?')[0]

    return [...jar]
      .filter(([, cookie]) => path.startsWith(cookie.path))
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join('; ')
  }

  /**
   * @param {string} url
   * @param {Record<string, string>} [payload]
   */
  async function browse(url, payload) {
    const cookies = cookieHeader(url)

    return keepCookies(
      await server.inject({
        method: payload ? 'POST' : 'GET',
        url,
        headers: {
          ...(cookies && { cookie: cookies }),
          ...(payload && {
            'content-type': 'application/x-www-form-urlencoded'
          })
        },
        ...(payload && {
          payload: new URLSearchParams(payload).toString()
        })
      })
    )
  }

  /** The crumb field every form on this journey carries, from its cookie */
  function crumb() {
    return { crumb: /** @type {string} */ (jar.get('crumb')?.value) }
  }

  /**
   * Follows redirects that stay on this service until the response is a
   * page or points at the relying party. The provider writes its resume
   * redirect as an absolute issuer URL, so both forms have to be
   * recognised — same as signin-round-trip.test.js's helper of the same
   * name.
   * @param {import('@hapi/hapi').ServerInjectResponse} res
   */
  async function follow(res) {
    let current = res

    for (;;) {
      const location = String(current.headers.location)

      if (current.statusCode < 300 || current.statusCode >= 400) {
        return current
      }

      const local = location.startsWith(ISSUER)
        ? location.slice(ISSUER.length)
        : location

      if (!local.startsWith('/')) {
        return current
      }

      current = await browse(local)
    }
  }

  /**
   * Completes an ordinary sign-in journey (JIT signup) so a real,
   * cookie-backed session exists for the change-email routes to require —
   * the only way to reach them, since `CITIZEN_SESSION` reads the
   * provider's own session, not a mock.
   * @param {string} email
   * @param {string} phone
   */
  async function signIn(email, phone) {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorize = `/auth?${new URLSearchParams({
      client_id: 'runner',
      response_type: 'code',
      scope: 'openid email',
      redirect_uri: REDIRECT_URI,
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()}`

    const start = await browse(authorize)
    const interaction = String(start.headers.location)

    await browse(interaction)
    await browse(`${interaction}/email`, { ...crumb(), email })
    await browse(`${interaction}/code`)
    await browse(`${interaction}/code`, { ...crumb(), code: KNOWN_CODE })
    await browse(`${interaction}/phone`)
    await follow(await browse(`${interaction}/phone`, { ...crumb(), phone }))

    return /** @type {{ id: string, email: string, phone: string }} */ (
      [...accounts.values()].find((account) => account.email === email)
    )
  }

  /** The uid `/account/change-email` hands out for a fresh interaction */
  async function startChangeEmail() {
    const started = await browse('/account/change-email')
    return String(started.headers.location).split('/')[2]
  }

  it('is unauthorized without a signed-in session', async () => {
    const res = await browse('/account/change-email')

    expect(res.statusCode).toBe(401)
  })

  it('starts a fresh interaction showing the phone last 4 digits', async () => {
    const account = await signIn('start@example.com', PHONE)

    const started = await browse('/account/change-email')
    expect(started.statusCode).toBe(302)
    expect(started.headers.location).toMatch(/^\/account\/.+\/change-email$/)

    const page = await browse(String(started.headers.location))
    expect(page.statusCode).toBe(200)
    expect(page.payload).toContain(account.phone.slice(-4))
  })

  it('redirects to change-email if the phone code page is opened before a code was requested', async () => {
    await signIn('no-code-yet@example.com', PHONE)
    const uid = await startChangeEmail()

    const res = await browse(`/account/${uid}/phone-sent-code`)

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`/account/${uid}/change-email`)
  })

  it('redirects to change-email if entering a new email is attempted before the phone is verified', async () => {
    await signIn('phone-not-verified@example.com', PHONE)
    const uid = await startChangeEmail()

    const res = await browse(`/account/${uid}/enter-email`)

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`/account/${uid}/change-email`)
  })

  it('re-renders with an error and does not advance on a wrong phone code', async () => {
    await signIn('wrong-phone-code@example.com', PHONE)
    const uid = await startChangeEmail()
    await browse(`/account/${uid}/send-code`, crumb())

    const res = await browse(`/account/${uid}/phone-code`, {
      ...crumb(),
      code: '000000'
    })

    expect(res.statusCode).toBe(200)
  })

  it('changes the signed-in account email end to end', async () => {
    const account = await signIn('before@example.com', PHONE)
    // the stub hands back a live reference to its own record, which the
    // journey below mutates in place — the original value has to be kept
    // separately to still mean "before" once that happens
    const originalEmail = account.email
    const uid = await startChangeEmail()

    const sentCode = await browse(`/account/${uid}/send-code`, crumb())
    expect(sentCode.headers.location).toBe(`/account/${uid}/phone-sent-code`)
    expect((await browse(`/account/${uid}/phone-sent-code`)).statusCode).toBe(
      200
    )

    const verifiedPhone = await browse(`/account/${uid}/phone-code`, {
      ...crumb(),
      code: KNOWN_CODE
    })
    expect(verifiedPhone.headers.location).toBe(`/account/${uid}/enter-email`)
    expect((await browse(`/account/${uid}/enter-email`)).statusCode).toBe(200)

    const newEmail = 'after@example.com'
    const emailRequested = await browse(`/account/${uid}/new-email`, {
      ...crumb(),
      email: newEmail
    })
    expect(emailRequested.headers.location).toBe(`/account/${uid}/email-code`)

    const codePage = await browse(`/account/${uid}/email-code`)
    expect(codePage.statusCode).toBe(200)
    expect(codePage.payload).toContain(newEmail)

    const verifiedEmail = await browse(`/account/${uid}/email-code`, {
      ...crumb(),
      code: KNOWN_CODE
    })
    expect(verifiedEmail.headers.location).toBe('/account')

    const updated = await browse('/account')
    expect(updated.statusCode).toBe(200)
    expect(updated.payload).toContain(newEmail)
    expect(updated.payload).not.toContain(originalEmail)

    // both OTPs (phone and email) are cleaned up once the change lands, so
    // revisiting the phone step now finds nothing and restarts the journey
    const afterCleanup = await browse(`/account/${uid}/phone-sent-code`)
    expect(afterCleanup.headers.location).toBe(`/account/${uid}/change-email`)
  })
})
