/**
 * Helper for the round-trip tests. It uses the real service through its
 * routes, as a browser does. The service uses a stub forms-identity-api on
 * loopback.
 *
 * The stub replaces both parts of the API that the UI uses. One part is the
 * artifact store behind the oidc-provider adapter. The other part is the OTP
 * and account endpoints behind the sign-in service. The stub records each
 * request, so a test can check the API traffic.
 */
/* global afterAll, beforeAll, beforeEach, expect -- Jest supplies these, because only test files use this helper */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'

import { SignJWT, importJWK } from 'jose'

export const ISSUER = 'http://localhost:3011'
export const REDIRECT_URI = 'http://localhost:3009/callback'
export const KNOWN_CODE = '123456'
export const PHONE = '07911 123456'
export const CLIENT_ASSERTION_TYPE =
  'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

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

const NOT_FOUND = { status: 404, body: { message: 'not found' } }
const NO_CONTENT = { status: 204, body: undefined }

/**
 * @param {IncomingMessage} req
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

/**
 * The stub API and its records
 */
function createStubApi() {
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
    // absent is a 204 here, matching the store: a bodiless response reads
    // back as an empty Buffer, so this also proves the adapter keys off the
    // status
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
   * Routing is by path shape rather than a router, so the shapes the UI
   * actually sends are visible in one place.
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
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

    // A bodiless response carries no content type, exactly as hapi sends it.
    // That matters here: Wreck only parses JSON when the content type says
    // so, so a real 204 reads back as an empty Buffer while a JSON-typed one
    // reads as null. Declaring JSON on an empty body would let a body test
    // stand in for a status test and hide the difference.
    if (result.body === undefined) {
      res.writeHead(result.status)
      res.end()
      return
    }

    res.writeHead(result.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.body))
  }

  return { handle, seenPaths, seenAuthorizations, artifacts, accounts }
}

/**
 * Signs the assertion the runner authenticates with
 */
export async function clientAssertion() {
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
 * Starts the stub API and the service for the enclosing describe block.
 * Returns a browser with its own cookie jar. Call it in `describe`, before
 * the other hooks of the block. The service then starts before those hooks
 * run.
 * @param {jest.Mock} mockStsSend - the `send` function of the STS client.
 * The test file must mock it, because jest hoists `jest.mock` only in the
 * test file.
 */
export function useRoundTrip(mockStsSend) {
  const api = createStubApi()
  /** Cookie jar: name -> { value, path } */
  const jar = new Map()
  /** @type {HttpServer} */
  let stub
  /** @type {Server} */
  let server

  beforeAll(async () => {
    stub = createHttpServer((req, res) => {
      api.handle(req, res).catch(() => {
        res.writeHead(500)
        res.end()
      })
    })
    await new Promise((resolve) => {
      stub.listen({ port: 0, host: '127.0.0.1' }, () => resolve(undefined))
    })

    const { port } = /** @type {AddressInfo} */ (stub.address())
    // Config reads the environment when it loads. Import the server only
    // after the stub has an address.
    process.env.IDENTITY_API_URL = `http://127.0.0.1:${port}`

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
  // test file's jest.mock() call
  beforeEach(() => {
    mockStsSend.mockResolvedValue({ WebIdentityToken: 'stub-service-token' })
  })

  /**
   * Stores the response's cookies and returns the response
   * @template {object | string} T
   * @param {ServerInjectResponse<T>} res
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
   * @param {ServerInjectResponse} res
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

  /**
   * Signs a new citizen in through the full journey, in a new browser. Then
   * redeems the code at the token endpoint.
   * @param {string} email
   * @param {object} [options]
   * @param {string} [options.state]
   * @param {string} [options.resource] - sent to the authorization endpoint.
   * If only the token endpoint gets it, the provider returns an opaque token
   * and no error.
   * @param {Record<string, string>} [options.tokenParams] - added to the token
   * request
   */
  async function signInAndRedeem(
    email,
    { state = 'state', resource, tokenParams = {} } = {}
  ) {
    // a fresh browser: an earlier journey left a session that would resume
    jar.clear()

    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    const authorize = `/auth?${new URLSearchParams({
      client_id: 'runner',
      response_type: 'code',
      scope: 'openid email',
      redirect_uri: REDIRECT_URI,
      state,
      nonce: `nonce-${state}`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(resource && { resource })
    }).toString()}`

    const start = await browse(authorize)
    const interaction = String(start.headers.location)

    // each page is loaded before it is submitted, to get its crumb
    await browse(interaction)
    await browse(`${interaction}/email`, { ...crumb(), email })
    await browse(`${interaction}/code`)
    await browse(`${interaction}/code`, { ...crumb(), code: KNOWN_CODE })
    await browse(`${interaction}/phone`)
    const finished = await follow(
      await browse(`${interaction}/phone`, { ...crumb(), phone: PHONE })
    )

    const callback = new URL(String(finished.headers.location))
    const code = /** @type {string} */ (callback.searchParams.get('code'))
    expect(code).toBeTruthy()

    return tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(),
      ...tokenParams
    })
  }

  return {
    ...api,
    jar,
    get server() {
      return server
    },
    keepCookies,
    cookieHeader,
    browse,
    crumb,
    follow,
    tokenRequest,
    signInAndRedeem
  }
}

/**
 * @import { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http'
 * @import { AddressInfo } from 'node:net'
 * @import { Server, ServerInjectResponse } from '@hapi/hapi'
 */
