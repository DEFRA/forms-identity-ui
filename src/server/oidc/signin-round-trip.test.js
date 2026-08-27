/**
 * Whole sign-in journey against a stub forms-identity-api on loopback.
 *
 * Two things are proved here that unit tests cannot. First, that the digest
 * is applied consistently: a mismatch between what one call site writes and
 * what another reads gives a 404, so the journey simply stops rather than
 * raising anything. Second, the acceptance criterion for this change — no
 * request path the stub saw carries a value the browser holds as a cookie or
 * the relying party receives in its callback.
 *
 * The stub replaces both halves of the API the UI talks to: the artifact
 * store behind the oidc-provider adapter, and the OTP/account endpoints
 * behind the sign-in service.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'

// The journey retrieves a caller token for every request the adapter and
// sign-in service make, so STS is stubbed here too — this test checks what
// the API traffic contains and what it must not leak, not STS connectivity,
// which service-token.test.js already covers.
const mockStsSend = jest.fn()

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: jest.fn()
  })),
  GetWebIdentityTokenCommand: jest.fn((input) => ({ input }))
}))

// Jest runs a suite in its own realm while Node's own globals belong to the
// host realm, so a structuredClone result carries the host's Object as its
// constructor. oidc-provider recognises plain objects by that identity and
// clones client metadata on startup, so a JSON round trip is substituted to
// keep the clone inside this realm. Nothing the provider clones is outside
// what JSON can carry.
globalThis.structuredClone = /** @type {typeof structuredClone} */ (
  /** @param {unknown} value */
  (value) => JSON.parse(JSON.stringify(value))
)

const ISSUER = 'http://localhost:3011'
const REDIRECT_URI = 'http://localhost:3009/callback'
const KNOWN_CODE = '123456'
const EMAIL = 'someone@example.com'
const PHONE = '07911 123456'

/**
 * Every request line the stub answered, in order
 * @type {string[]}
 */
const seenPaths = []
/**
 * The Authorization header the stub saw on each request, in the same order
 * as seenPaths — this is what shows the caller token passes through the
 * real server, adapter and Wreck without being dropped along the way
 * @type {(string | undefined)[]}
 */
const seenAuthorizations = []
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
 * The stub API. Routing is by path shape rather than a router, so the shapes
 * the UI actually sends are visible in one place.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
async function handle(req, res) {
  const path = /** @type {string} */ (req.url)
  const method = /** @type {string} */ (req.method)
  seenPaths.push(`${method} ${path}`)
  seenAuthorizations.push(req.headers.authorization)

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

  res.writeHead(result.status, { 'content-type': 'application/json' })
  res.end(result.body === undefined ? '' : JSON.stringify(result.body))
}

describe('sign-in round trip', () => {
  /** @type {import('node:http').Server} */
  let stub
  /** @type {import('@hapi/hapi').Server} */
  let server
  /** @type {(id: string) => string} */
  let hashId
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
    // config reads the environment as it loads, so the server and the helper
    // are imported only once the stub's address is known
    process.env.IDENTITY_API_URL = `http://127.0.0.1:${port}`
    ;({ hashId } = await import('~/src/server/common/helpers/hash-id.js'))

    const { createServer } = await import('~/src/server/index.js')
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
    await new Promise((resolve) => stub.close(resolve))
  })

  // resetMocks wipes a jest.fn() implementation before every test, so the
  // token STS hands back is reinstated here rather than relied on from the
  // jest.mock() call above
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
   * The Cookie header for a path, honouring the path each cookie was scoped
   * to — the provider scopes the interaction cookies to one journey
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
   * or points at the relying party. The provider writes its resume redirect
   * as an absolute issuer URL, so both forms have to be recognised.
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

  it('signs a user in end to end and leaks nothing into a request path', async () => {
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

    // the provider parks the request and sends the browser to the email page
    const start = await browse(authorize)
    expect(start.statusCode).toBe(303)

    const interaction = String(start.headers.location)
    const uid = interaction.split('/')[2]
    expect((await browse(interaction)).statusCode).toBe(200)

    const emailed = await browse(`${interaction}/email`, {
      ...crumb(),
      email: EMAIL
    })
    expect(emailed.headers.location).toBe(`${interaction}/code`)
    expect((await browse(`${interaction}/code`)).statusCode).toBe(200)

    // no account yet, so a correct code moves on to the phone step
    const coded = await browse(`${interaction}/code`, {
      ...crumb(),
      code: KNOWN_CODE
    })
    expect(coded.headers.location).toBe(`${interaction}/phone`)
    expect((await browse(`${interaction}/phone`)).statusCode).toBe(200)

    // completing the phone step finishes the interaction; the provider then
    // resumes, auto-grants consent and issues the code
    const finished = await follow(
      await browse(`${interaction}/phone`, { ...crumb(), phone: PHONE })
    )

    const callback = new URL(String(finished.headers.location))
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI)
    expect(callback.searchParams.get('state')).toBe('state-1')

    const authorizationCode = /** @type {string} */ (
      callback.searchParams.get('code')
    )
    expect(authorizationCode).toBeTruthy()
    expect(accounts.size).toBe(1)

    // The acceptance criterion: nothing the browser or the relying party
    // holds is recoverable from a path the API's proxies and logs recorded.
    // The interaction uid is here too — it is in the UI's own URLs, which is
    // a documented residual, but it must not reach the API in plaintext.
    const secrets = [
      ...[...jar.values()].map((cookie) => decodeURIComponent(cookie.value)),
      authorizationCode,
      uid
    ].filter((secret) => secret.length > 8)

    expect(secrets.length).toBeGreaterThan(2)
    for (const secret of secrets) {
      expect(seenPaths.join('\n')).not.toContain(secret)
    }

    // and the digest is what took its place — the journey only reaches here
    // if every key matched, because a digest on one side and a plaintext
    // value on the other is a 404 rather than a failure
    const sessionCookie = /** @type {string} */ (jar.get('_session')?.value)
    expect(sessionCookie).toBeTruthy()
    expect(seenPaths.some((path) => path.includes(hashId(sessionCookie)))).toBe(
      true
    )
    expect(
      seenPaths.some((path) => path.includes(hashId(authorizationCode)))
    ).toBe(true)

    // The caller token passes through the real server, adapter and Wreck:
    // every request the stub saw carried it, so nothing along that path
    // drops or changes the header.
    expect(seenAuthorizations.length).toBeGreaterThan(0)
    for (const authorization of seenAuthorizations) {
      expect(authorization).toBe('Bearer stub-service-token')
    }
  })
})
