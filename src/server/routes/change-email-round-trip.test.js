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

    if (!account || !record) {
      return NOT_FOUND
    }

    const target = record.target.trim().toLowerCase()

    if (account.email.toLowerCase() === target) {
      return { status: 200, body: { status: 'email-same-as-current' } }
    }
    if (
      [...accounts.values()].some(
        (other) =>
          other.id !== account.id && other.email.toLowerCase() === target
      )
    ) {
      return { status: 200, body: { status: 'email-already-in-use' } }
    }

    account.email = record.target

    // this endpoint cascades the cleanup of every OTP tied to the
    // interaction (phone and email) once the change lands
    for (const key of [...otps.keys()]) {
      if (key.startsWith(`${hashedUid}:`)) {
        otps.delete(key)
      }
    }
    return { status: 200, body: { status: 'signed-in', accountId: account.id } }
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

  /** Opens the change-email journey using the signed-in session */
  async function startChangeEmail() {
    return browse('/account/change-email')
  }

  /** Requests the phone code and submits the right one */
  async function verifyPhone() {
    await startChangeEmail()
    await browse('/account/send-code', crumb())
    await browse('/account/phone-code', { ...crumb(), code: KNOWN_CODE })
  }

  /** Verifies the phone, then requests a code for the new email address */
  async function requestEmailCode(/** @type {string} */ email) {
    await verifyPhone()
    return browse('/account/enter-email', { ...crumb(), email })
  }

  it.each([
    ['GET', '/account/change-email'],
    ['POST', '/account/send-code'],
    ['GET', '/account/phone-sent-code'],
    ['POST', '/account/phone-code'],
    ['GET', '/account/enter-email'],
    ['POST', '/account/enter-email'],
    ['GET', '/account/email-code'],
    ['POST', '/account/email-code'],
    ['GET', '/account/code/resend'],
    ['GET', '/account/change-email-error']
  ])(
    '%s %s is unauthorized without a signed-in session',
    async (method, url) => {
      const res = await server.inject({ method, url })

      expect(res.statusCode).toBe(401)
    }
  )

  it('starts the journey showing the phone last 4 digits', async () => {
    const account = await signIn('start@example.com', PHONE)

    const page = await startChangeEmail()
    expect(page.statusCode).toBe(200)
    expect(page.payload).toContain(account.phone.slice(-4))
  })

  it('redirects to change-email if the phone code page is opened before a code was requested', async () => {
    await signIn('no-code-yet@example.com', PHONE)
    await startChangeEmail()

    const res = await browse('/account/phone-sent-code')

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/account/change-email')
  })

  it('shows the resend notification on the phone code page after a resend', async () => {
    await signIn('resend-phone@example.com', PHONE)
    await startChangeEmail()

    const resent = await browse('/account/send-code?resend=true', crumb())
    expect(resent.headers.location).toBe('/account/phone-sent-code')

    const page = await browse('/account/phone-sent-code')
    expect(page.statusCode).toBe(200)
    expect(page.payload).toContain('We’ve sent you a new security code.')

    // the notification is flashed, so it only shows once
    const again = await browse('/account/phone-sent-code')
    expect(again.payload).not.toContain('We’ve sent you a new security code.')
  })

  it.each([
    ['a wrong code', '000000', 'The code you entered is not correct'],
    ['no code', '', 'Enter the 6 digit security code']
  ])(
    're-renders the phone code page with an error and does not advance on %s',
    async (_name, code, message) => {
      await signIn(`phone-${code || 'empty'}@example.com`, PHONE)
      await startChangeEmail()
      await browse('/account/send-code', crumb())

      const res = await browse('/account/phone-code', { ...crumb(), code })

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain(message)

      const enterEmail = await browse('/account/enter-email')
      expect(enterEmail.statusCode).toBe(302)
      expect(enterEmail.headers.location).toBe('/account/change-email')
    }
  )

  it('re-renders the phone code page when the phone code has expired or was never requested', async () => {
    await signIn('phone-expired@example.com', PHONE)
    await startChangeEmail()

    const res = await browse('/account/phone-code', {
      ...crumb(),
      code: KNOWN_CODE
    })

    expect(res.statusCode).toBe(200)
  })

  it('redirects to change-email if entering a new email is attempted before the phone is verified', async () => {
    await signIn('phone-not-verified@example.com', PHONE)
    await startChangeEmail()

    const get = await browse('/account/enter-email')
    expect(get.statusCode).toBe(302)
    expect(get.headers.location).toBe('/account/change-email')

    const post = await browse('/account/enter-email', {
      ...crumb(),
      email: 'new@example.com'
    })
    expect(post.statusCode).toBe(302)
    expect(post.headers.location).toBe('/account/change-email')
  })

  it.each([
    ['empty', '', 'Enter an email address'],
    ['badly formatted', 'not-an-email', 'in the correct format']
  ])(
    're-renders the enter email page with an error for a(n) %s email',
    async (_name, email, message) => {
      await signIn(`invalid-${_name.replace(/\s/g, '-')}@example.com`, PHONE)
      await verifyPhone()

      const res = await browse('/account/enter-email', { ...crumb(), email })

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain(message)
    }
  )

  it('rejects the account’s current email address', async () => {
    await signIn('same@example.com', PHONE)
    await verifyPhone()

    const res = await browse('/account/enter-email', {
      ...crumb(),
      email: ' SAME@example.com '
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('This is the same as your current email')
  })

  it('redirects to change-email if the email code page is opened before the phone is verified', async () => {
    await signIn('email-code-no-phone@example.com', PHONE)
    await startChangeEmail()

    const get = await browse('/account/email-code')
    expect(get.headers.location).toBe('/account/change-email')

    const post = await browse('/account/email-code', {
      ...crumb(),
      code: KNOWN_CODE
    })
    expect(post.headers.location).toBe('/account/change-email')
  })

  it('redirects to change-email if the email code page is opened before an email code was requested', async () => {
    await signIn('no-email-code@example.com', PHONE)
    await verifyPhone()

    const res = await browse('/account/email-code')

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/account/change-email')
  })

  it('re-renders the email code page with the new email on a wrong email code', async () => {
    await signIn('wrong-email-code@example.com', PHONE)
    const requested = await requestEmailCode('wrong-new@example.com')
    expect(requested.headers.location).toBe('/account/email-code')

    const res = await browse('/account/email-code', {
      ...crumb(),
      code: '000000'
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('The code you entered is not correct')
    expect(res.payload).toContain('wrong-new@example.com')
  })

  it('shows the resend notification on the email code page after a resend', async () => {
    await signIn('resend-email@example.com', PHONE)
    await verifyPhone()

    const resent = await browse('/account/enter-email?resend=true', {
      ...crumb(),
      email: 'resent@example.com'
    })
    expect(resent.headers.location).toBe('/account/email-code')

    const page = await browse('/account/email-code')
    expect(page.statusCode).toBe(200)
    expect(page.payload).toContain('We’ve sent you a new security code.')
  })

  describe('code resend page', () => {
    it('shows the phone last 4 digits for a phone resend', async () => {
      await signIn('resend-page-sms@example.com', PHONE)

      const res = await browse('/account/code/resend?transport=sms')

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain(PHONE.slice(-4))
      expect(res.payload).toContain('/account/send-code?resend=true')
    })

    it('shows the new email address for an email resend', async () => {
      await signIn('resend-page-email@example.com', PHONE)
      await requestEmailCode('resend-target@example.com')
      await browse('/account/email-code')

      const res = await browse('/account/code/resend?transport=email')

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain('resend-target@example.com')
      expect(res.payload).toContain('/account/enter-email?resend=true')
    })
  })

  it('shows the error page if the new email is already used by another account', async () => {
    await signIn('taken@example.com', PHONE)
    jar.clear()
    await signIn('wants-taken@example.com', PHONE)
    await requestEmailCode('taken@example.com')

    const verified = await browse('/account/email-code', {
      ...crumb(),
      code: KNOWN_CODE
    })
    expect(verified.headers.location).toBe('/account/change-email-error')

    const page = await browse('/account/change-email-error')
    expect(page.statusCode).toBe(200)
    expect(page.payload).toContain('Your email address was not updated')
    expect(page.payload).toContain('already used for another sign-in')

    // the error is flashed, so it only shows once
    const again = await browse('/account/change-email-error')
    expect(again.payload).not.toContain('already used for another sign-in')
  })

  it('changes the signed-in account email end to end', async () => {
    const account = await signIn('before@example.com', PHONE)
    // the stub hands back a live reference to its own record, which the
    // journey below mutates in place — the original value has to be kept
    // separately to still mean "before" once that happens
    const originalEmail = account.email
    await startChangeEmail()

    const sentCode = await browse('/account/send-code', crumb())
    expect(sentCode.headers.location).toBe('/account/phone-sent-code')
    expect((await browse('/account/phone-sent-code')).statusCode).toBe(200)

    const verifiedPhone = await browse('/account/phone-code', {
      ...crumb(),
      code: KNOWN_CODE
    })
    expect(verifiedPhone.headers.location).toBe('/account/enter-email')
    expect((await browse('/account/enter-email')).statusCode).toBe(200)

    const newEmail = 'after@example.com'
    const emailRequested = await browse('/account/enter-email', {
      ...crumb(),
      email: newEmail
    })
    expect(emailRequested.headers.location).toBe('/account/email-code')

    const codePage = await browse('/account/email-code')
    expect(codePage.statusCode).toBe(200)
    expect(codePage.payload).toContain(newEmail)

    const verifiedEmail = await browse('/account/email-code', {
      ...crumb(),
      code: KNOWN_CODE
    })
    expect(verifiedEmail.headers.location).toBe('/account')

    const updated = await browse('/account')
    expect(updated.statusCode).toBe(200)
    expect(updated.payload).toContain(newEmail)
    expect(updated.payload).not.toContain(originalEmail)
    expect(updated.payload).toContain('Your email address has been changed.')

    // both OTPs (phone and email) are cleaned up once the change lands, so
    // revisiting the phone step now finds nothing and restarts the journey
    const afterCleanup = await browse('/account/phone-sent-code')
    expect(afterCleanup.headers.location).toBe('/account/change-email')
  })
})
