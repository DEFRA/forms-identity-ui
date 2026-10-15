/**
 * Whole delete-account journey against a stub forms-identity-api on
 * loopback, starting from a real signed-in session produced by the ordinary
 * sign-in journey.
 *
 * This proves that the email OTP gates account deletion and that a successful
 * deletion revokes every grant and ends the OIDC session.
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

globalThis.structuredClone = /** @type {typeof structuredClone} */ (
  /** @param {unknown} value */
  (value) => JSON.parse(JSON.stringify(value))
)

const ISSUER = 'http://localhost:3011'
const REDIRECT_URI = 'http://localhost:3009/callback'
const KNOWN_CODE = '123456'
const PHONE = '07911 123456'

/** @type {Map<string, Record<string, unknown>>} */
const artifacts = new Map()
/** @type {Map<string, { target: string, verified: boolean }>} */
const otps = new Map()
// when active, the fake API refuses every code request as locked out
const lockout = { active: false }
/** @type {Map<string, { id: string, email: string, phone: string }>} */
const accounts = new Map()
/** @type {string[]} */
const seenPaths = []

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
 * The OIDC adapter's persistence store.
 * @param {string} method
 * @param {string[]} segments
 * @param {{ payload?: Record<string, unknown> }} body
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
    return found ? { status: 200, body: found[1] } : NO_CONTENT
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
 * OTP API endpoints used by sign-in and the deletion journey.
 * @param {string} method
 * @param {string[]} segments
 * @param {Record<string, string>} body
 */
function otpEndpoints(method, segments, body) {
  const [first, second] = segments

  if (method === 'POST' && first === 'request') {
    if (lockout.active) {
      return {
        status: 200,
        body: {
          status: 'locked-out',
          lockedUntil: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
        }
      }
    }

    otps.set(`${body.uid}:${body.purpose}`, {
      target: body.target,
      verified: false
    })
    return { status: 200, body: { status: 'otp-issued' } }
  }

  if (method === 'POST' && first === 'verify') {
    const record = otps.get(`${body.uid}:${body.purpose}`)
    if (!record || body.code !== KNOWN_CODE) {
      return {
        status: 200,
        body: {
          status: record ? 'invalid' : 'invalid-code-consumed-or-expired'
        }
      }
    }
    record.verified = true

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
 * Account API endpoints used by sign-in, account lookup and deletion.
 * @param {string} method
 * @param {string[]} segments
 * @param {Record<string, string>} body
 */
function accountsEndpoints(method, segments, body) {
  if (method === 'POST' && segments.length === 0) {
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

  if (method === 'DELETE' && segments.length === 2) {
    const [uid, accountId] = segments
    const record = otps.get(
      `${uid}:${PURPOSE.ACCOUNT_DELETE_ACCOUNT_VERIFY_EMAIL}`
    )
    if (!record?.verified || !accounts.has(accountId)) {
      return NOT_FOUND
    }

    accounts.delete(accountId)
    for (const key of [...otps.keys()]) {
      if (key.startsWith(`${uid}:`)) {
        otps.delete(key)
      }
    }
    return { status: 200, body: { status: 'complete' } }
  }

  if (method === 'GET' && segments.length === 1) {
    const account = accounts.get(segments[0])
    return account ? { status: 200, body: account } : NOT_FOUND
  }

  return NOT_FOUND
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handle(req, res) {
  const path = /** @type {string} */ (req.url)
  const method = /** @type {string} */ (req.method)
  seenPaths.push(`${method} ${path}`)
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

  if (result.body === undefined) {
    res.writeHead(result.status)
    res.end()
    return
  }

  res.writeHead(result.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result.body))
}

describe('delete-account round trip', () => {
  /** @type {import('node:http').Server} */
  let stub
  /** @type {import('@hapi/hapi').Server} */
  let server
  /** @type {Map<string, { value: string, path: string }>} */
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
    artifacts.clear()
    otps.clear()
    lockout.active = false
    accounts.clear()
    seenPaths.length = 0
    mockStsSend.mockResolvedValue({ WebIdentityToken: 'stub-service-token' })
  })

  /**
   * Stores response cookies and returns the response.
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

  /** @param {string} url */
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

  function crumb() {
    return { crumb: /** @type {string} */ (jar.get('crumb')?.value) }
  }

  /**
   * Follows redirects within this service until a page or the RP is reached.
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
   * Completes sign-in to create a real account and provider session.
   * @param {string} email
   */
  async function signIn(email) {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorize = `/auth?${new URLSearchParams({
      client_id: 'runner',
      response_type: 'code',
      scope: 'openid email offline_access',
      prompt: 'login consent',
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
    await follow(
      await browse(`${interaction}/phone`, { ...crumb(), phone: PHONE })
    )

    return /** @type {{ id: string, email: string, phone: string }} */ (
      [...accounts.values()].find((account) => account.email === email)
    )
  }

  it.each([
    ['GET', '/account/delete-account'],
    ['POST', '/account/delete-account/send-code'],
    ['GET', '/account/delete-account/email-code'],
    ['POST', '/account/delete-account/email-code'],
    ['GET', '/account/delete-account/code/resend']
  ])(
    '%s %s is unauthorized without a signed-in session',
    async (method, url) => {
      const response = await server.inject({ method, url })
      expect(response.statusCode).toBe(401)
    }
  )

  it('starts the journey with the account email and sends a verification code', async () => {
    const account = await signIn('delete-start@example.com')

    const start = await browse('/account/delete-account')
    expect(start.statusCode).toBe(200)
    expect(start.payload).toContain(account.email)

    const sent = await browse('/account/delete-account/send-code', crumb())
    expect(sent.statusCode).toBe(302)
    expect(sent.headers.location).toBe('/account/delete-account/email-code')

    const codePage = await browse('/account/delete-account/email-code')
    expect(codePage.statusCode).toBe(200)
    expect(codePage.payload).toContain(account.email)
  })

  it('redirects to the start if the code page is opened before a code was requested', async () => {
    await signIn('delete-no-code@example.com')

    const response = await browse('/account/delete-account/email-code')
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/delete-account')
  })

  it.each([
    ['wrong', '000000', 'The code you entered is not correct'],
    ['empty', '', 'Enter the 6 digit security code']
  ])(
    'does not delete the account when the %s code is submitted',
    async (_name, code, message) => {
      const account = await signIn(`delete-invalid-${_name}@example.com`)
      await browse('/account/delete-account/send-code', crumb())

      const response = await browse('/account/delete-account/email-code', {
        ...crumb(),
        code
      })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe(
        '/account/delete-account/email-code'
      )

      const codePage = await browse('/account/delete-account/email-code')
      expect(codePage.statusCode).toBe(200)
      expect(codePage.payload).toContain(message)
      expect(accounts.has(account.id)).toBe(true)
    }
  )

  it.each([
    ['requesting', '/account/delete-account/send-code'],
    ['resending', '/account/delete-account/send-code?resend=true']
  ])(
    'shows the locked out page and keeps the account when %s a code is refused',
    async (_name, url) => {
      const account = await signIn(`delete-locked-${url.length}@example.com`)
      lockout.active = true

      const res = await browse(url, crumb())

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain('Too many security codes requested')
      expect(res.payload).toContain('Try again in 2 hours.')

      const codePage = await browse('/account/delete-account/email-code')
      expect(codePage.statusCode).toBe(302)
      expect(accounts.has(account.id)).toBe(true)
    }
  )

  it('deletes the account, revokes every grant, and ends the signed-in session after valid verification', async () => {
    const account = await signIn('delete-success@example.com')
    const sessionEntry = [...artifacts].find(
      ([key, artifact]) =>
        key.startsWith('session/') && typeof artifact.uid === 'string'
    )
    expect(sessionEntry).toBeDefined()
    if (!sessionEntry) {
      throw new Error('The sign-in did not persist an OIDC session')
    }
    const sessionUid = /** @type {string} */ (sessionEntry[1].uid)
    const session = sessionEntry[1]
    const authorizations =
      /** @type {Record<string, { grantId?: string }> | undefined} */ (
        session.authorizations
      )
    const grantIds = [
      ...new Set(
        Object.values(authorizations ?? {})
          .map(({ grantId }) => grantId)
          .filter((grantId) => Boolean(grantId))
      )
    ]
    expect(grantIds.length).toBeGreaterThan(0)

    await browse('/account/delete-account/send-code', crumb())
    const deleted = await browse('/account/delete-account/email-code', {
      ...crumb(),
      code: KNOWN_CODE
    })

    expect(deleted.statusCode).toBe(200)
    expect(deleted.payload).toContain('Your sign-in has been deleted')
    expect(accounts.has(account.id)).toBe(false)
    expect(seenPaths.some((path) => path.startsWith(`DELETE /accounts/`))).toBe(
      true
    )
    for (const grantId of grantIds) {
      expect(seenPaths).toContain(`DELETE /oidc/grants/${grantId}`)
      expect(
        [...artifacts.values()].some((artifact) => artifact.grantId === grantId)
      ).toBe(false)
    }
    expect(
      [...artifacts.values()].some((artifact) => artifact.uid === sessionUid)
    ).toBe(false)

    const accountPage = await browse('/account')
    expect(accountPage.statusCode).toBe(404)
    expect(accountPage.payload).toContain('Page not found')
  })
})
