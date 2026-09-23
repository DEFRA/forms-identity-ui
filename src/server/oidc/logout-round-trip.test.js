/**
 * Proves that signing out actually ends a session, rather than just
 * redirecting the browser. A citizen signs in, uses the access token that
 * grants against the userinfo endpoint (a protected resource: it requires a
 * valid, unrevoked token, unlike the resource-bound JWTs the other round-trip
 * test covers), then signs out through RP-Initiated Logout. The same access
 * token is then replayed against that same protected resource: without the
 * session behind it, the token must be refused, not merely unrefreshed.
 *
 * The stub API and cookie-jar plumbing mirror signin-round-trip.test.js —
 * that test proves the sign-in journey itself leaks nothing; this one starts
 * from a completed sign-in and only adds what logout needs.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'

import { SignJWT, importJWK } from 'jose'

const mockStsSend = jest.fn()

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: jest.fn()
  })),
  GetWebIdentityTokenCommand: jest.fn((input) => ({ input }))
}))

// See signin-round-trip.test.js for why this stands in for structuredClone
globalThis.structuredClone = /** @type {typeof structuredClone} */ (
  /** @param {unknown} value */
  (value) => JSON.parse(JSON.stringify(value))
)

const ISSUER = 'http://localhost:3011'
const REDIRECT_URI = 'http://localhost:3009/callback'
const POST_LOGOUT_REDIRECT_URI = 'http://localhost:3009/auth/signed-out'
const KNOWN_CODE = '123456'
const EMAIL = 'logout-journey@example.com'
const PHONE = '07911 123456'
const CLIENT_ASSERTION_TYPE =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/**
 * Artifact payloads by `${model}/${id}`, standing in for the API's store
 * @type {Map<string, Record<string, unknown>>}
 */
const artifacts = new Map()
/**
 * OTP records by the uid the UI sends, standing in for the otps collection
 * @type {Map<string, { email: string, verified: boolean }>}
 */
const otps = new Map()
/**
 * Accounts by id
 * @type {Map<string, { id: string, email: string }>}
 */
const accounts = new Map()

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
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
 * The artifact store behind the oidc-provider adapter
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
    : NO_CONTENT
}

/**
 * The OTP and account endpoints behind the sign-in service
 * @param {string} method
 * @param {string[]} segments - the whole path, split
 * @param {Record<string, string>} body
 * @returns {{ status: number, body?: unknown }}
 */
function signinEndpoints(method, segments, body) {
  if (segments[0] === 'otp') {
    if (segments[1] === 'request') {
      otps.set(body.uid, { email: body.email, verified: false })
      return NO_CONTENT
    }
    if (segments[1] === 'verify') {
      const record = otps.get(body.uid)

      if (!record || body.code !== KNOWN_CODE) {
        return { status: 200, body: { status: 'invalid' } }
      }
      record.verified = true

      const existing = [...accounts.values()].find(
        (account) => account.email === record.email
      )
      return {
        status: 200,
        body: existing
          ? { status: 'signed-in', accountId: existing.id }
          : { status: 'phone-required' }
      }
    }

    const record = otps.get(segments[1])
    return record ? { status: 200, body: { email: record.email } } : NOT_FOUND
  }

  if (segments[0] === 'accounts') {
    if (method === 'POST') {
      const record = otps.get(body.uid)

      if (!record?.verified) {
        return { status: 200, body: { status: 'invalid' } }
      }
      const account = {
        id: randomBytes(16).toString('hex'),
        email: record.email
      }
      accounts.set(account.id, account)
      return {
        status: 200,
        body: { status: 'signed-in', accountId: account.id }
      }
    }

    const account = accounts.get(segments[1])
    return account ? { status: 200, body: account } : NOT_FOUND
  }

  return NOT_FOUND
}

/**
 * The stub API, routed by path shape as in signin-round-trip.test.js
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
      : signinEndpoints(
          method,
          segments,
          /** @type {Record<string, string>} */ (body)
        )

  if (result.body === undefined) {
    res.writeHead(result.status)
    res.end()
    return
  }

  res.writeHead(result.status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result.body))
}

describe('logout round trip', () => {
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
   * The Cookie header for a path, honouring the path each cookie was scoped to
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

  /** The crumb field every interaction form carries, from its own cookie */
  function crumb() {
    return { crumb: /** @type {string} */ (jar.get('crumb')?.value) }
  }

  /**
   * Follows redirects that stay on this service until the response is a page
   * or points at the relying party
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
   * Signs the assertion the runner authenticates with
   */
  async function clientAssertion() {
    const [jwk] = JSON.parse(String(process.env.OIDC_RUNNER_PRIVATE_JWKS)).keys

    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer('runner')
      .setSubject('runner')
      .setAudience(ISSUER)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(await importJWK(jwk, 'RS256'))
  }

  /**
   * Posts a form to the token endpoint as the runner
   * @param {Record<string, string>} params
   */
  function tokenRequest(params) {
    return server.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        client_id: 'runner',
        ...params
      }).toString()
    })
  }

  it('refuses a protected resource with a citizen’s access token once they have signed out', async () => {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    const authorize = `/auth?${new URLSearchParams({
      client_id: 'runner',
      response_type: 'code',
      scope: 'openid email',
      redirect_uri: REDIRECT_URI,
      state: 'logout-state',
      nonce: 'logout-nonce',
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()}`

    // the whole sign-in journey, exactly as signin-round-trip.test.js proves
    const start = await browse(authorize)
    const interaction = String(start.headers.location)

    await browse(interaction)
    await browse(`${interaction}/email`, { ...crumb(), email: EMAIL })
    await browse(`${interaction}/code`)
    await browse(`${interaction}/code`, { ...crumb(), code: KNOWN_CODE })
    await browse(`${interaction}/phone`)
    const finished = await follow(
      await browse(`${interaction}/phone`, { ...crumb(), phone: PHONE })
    )

    const callback = new URL(String(finished.headers.location))
    const authorizationCode = /** @type {string} */ (
      callback.searchParams.get('code')
    )
    expect(authorizationCode).toBeTruthy()

    // redeemed with no resource named, so the access token is opaque and can
    // reach the userinfo endpoint — a resource-bound JWT could not, per the
    // other round-trip test
    const redeemed = await tokenRequest({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion()
    })
    expect(redeemed.statusCode).toBe(200)

    const { access_token: accessToken, id_token: idToken } = JSON.parse(
      redeemed.payload
    )
    expect(accessToken).toBeTruthy()

    /** Calls the protected resource with the access token in hand */
    function callProtectedResource() {
      return server.inject({
        method: 'GET',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` }
      })
    }

    // the access token works against the protected resource while the
    // session behind it is alive
    const whileSignedIn = await callProtectedResource()
    expect(whileSignedIn.statusCode).toBe(200)
    expect(JSON.parse(whileSignedIn.payload)).toMatchObject({ email: EMAIL })

    // RP-Initiated Logout: the provider recognises the id_token_hint as the
    // signed-in citizen's own and ends the session without a confirmation
    // click (see rpInitiatedLogout.logoutSource in provider-config.js)
    const loggedOut = await browse(
      `/session/end?${new URLSearchParams({
        client_id: 'runner',
        id_token_hint: String(idToken),
        post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI,
        state: 'logout-state'
      }).toString()}`
    )
    expect(loggedOut.statusCode).toBe(303)
    expect(String(loggedOut.headers.location)).toContain(
      POST_LOGOUT_REDIRECT_URI
    )

    // the same access token, replayed against the same protected resource,
    // must now be refused — the token was only ever valid alongside the
    // session that logout just destroyed
    const afterSignOut = await callProtectedResource()
    expect(afterSignOut.statusCode).toBe(401)
    expect(JSON.parse(afterSignOut.payload)).toMatchObject({
      error: 'invalid_token'
    })
  })
})
