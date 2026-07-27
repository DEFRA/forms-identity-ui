import { createServer } from '~/src/server/index.js'

/**
 * Build a minimal fetch Response stand-in with full control over headers
 * (including multiple set-cookie values via Headers.append)
 * @param {number} status
 * @param {[string, string][]} [headerPairs]
 * @param {string} [body]
 */
function upstream(status, headerPairs = [], body = '') {
  const headers = new Headers()
  for (const [key, value] of headerPairs) {
    headers.append(key, value)
  }
  return /** @type {Response} */ (
    /** @type {unknown} */ ({
      status,
      headers,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer)
    })
  )
}

describe('oidc-proxy plugin', () => {
  /** @type {Server} */
  let server

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
  })

  test('proxies discovery GETs to the identity API with X-Forwarded-* derived from the configured issuer', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        upstream(
          200,
          [['content-type', 'application/json']],
          '{"issuer":"http://localhost:3002"}'
        )
      )

    const res = await server.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration',
      headers: {
        connection: 'keep-alive',
        'proxy-authorization': 'Basic secret',
        te: 'trailers'
      }
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.parse(res.payload)).toEqual({
      issuer: 'http://localhost:3002'
    })

    const [target, init] = fetchSpy.mock.calls[0]
    expect(target).toBe(
      'http://localhost:4001/.well-known/openid-configuration'
    )
    expect(init?.redirect).toBe('manual')
    expect(init?.signal).toBeInstanceOf(AbortSignal)

    const headers = /** @type {Record<string, string>} */ (init?.headers)
    // Derived from config `oidc.issuer`, never the inbound Host header
    expect(headers['x-forwarded-proto']).toBe('http')
    expect(headers['x-forwarded-host']).toBe('localhost:3002')
    expect(headers['x-forwarded-for']).toBeDefined()
    expect(headers.host).toBeUndefined()
    // RFC 7230 §6.1 hop-by-hop headers must not be relayed
    expect(headers.connection).toBeUndefined()
    expect(headers['proxy-authorization']).toBeUndefined()
    expect(headers.te).toBeUndefined()
  })

  test('preserves the query string on proxied requests', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(upstream(200, [], 'ok'))

    await server.inject({
      method: 'GET',
      url: '/auth/abc?client_id=runner&code_challenge=xyz'
    })

    expect(fetchSpy.mock.calls[0][0]).toBe(
      'http://localhost:4001/auth/abc?client_id=runner&code_challenge=xyz'
    )
  })

  test('relays upstream redirects untouched (redirect: manual, no templated error page)', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        upstream(302, [['location', 'http://localhost:3002/ui/interaction/u1']])
      )

    const res = await server.inject({
      method: 'GET',
      url: '/interaction/u1'
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('http://localhost:3002/ui/interaction/u1')
    expect(res.payload).not.toContain('<html')
  })

  test('fans out multiple upstream set-cookie headers', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      upstream(200, [
        ['set-cookie', '_interaction=abc; path=/auth; httponly'],
        ['set-cookie', '_session=def; path=/; httponly']
      ])
    )

    const res = await server.inject({ method: 'GET', url: '/interaction/u1' })

    expect(res.headers['set-cookie']).toEqual([
      '_interaction=abc; path=/auth; httponly',
      '_session=def; path=/; httponly'
    ])
  })

  test('drops stale content-encoding/content-length/transfer-encoding from the decompressed body', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      upstream(
        200,
        [
          ['content-encoding', 'gzip'],
          ['content-length', '9999'],
          ['content-type', 'text/plain']
        ],
        'decompressed'
      )
    )

    const res = await server.inject({ method: 'GET', url: '/jwks' })

    expect(res.headers['content-encoding']).toBeUndefined()
    // The stale upstream content-length (describing the compressed bytes) must
    // not be relayed; Node re-derives framing for the re-materialised body
    expect(res.headers['content-length']).not.toBe('9999')
    expect(res.payload).toBe('decompressed')
  })

  test('proxied POSTs are crumb-exempt and forward the raw payload bytes', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        upstream(
          200,
          [['content-type', 'application/json']],
          '{"access_token":"t"}'
        )
      )

    const payload = 'grant_type=authorization_code&code=abc'
    const res = await server.inject({
      method: 'POST',
      url: '/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload
    })

    // No crumb cookie/field supplied — must NOT be rejected with 403
    expect(res.statusCode).toBe(200)

    const [target, init] = fetchSpy.mock.calls[0]
    expect(target).toBe('http://localhost:4001/token')
    expect(init?.method).toBe('POST')
    expect(Buffer.from(/** @type {Buffer} */ (init?.body)).toString()).toBe(
      payload
    )
  })

  test('returns a raw 504 when the upstream fetch fails (connection refused/reset)', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'))

    const res = await server.inject({ method: 'GET', url: '/jwks' })

    expect(res.statusCode).toBe(504)
    expect(res.payload).toBe('Gateway Timeout')
  })

  test('returns a raw 504 when the upstream times out (AbortError)', async () => {
    const abortError = new Error('This operation was aborted')
    abortError.name = 'AbortError'
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)

    const res = await server.inject({ method: 'GET', url: '/me' })

    expect(res.statusCode).toBe(504)
    expect(res.payload).toBe('Gateway Timeout')
    expect(res.payload).not.toContain('<html')
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
