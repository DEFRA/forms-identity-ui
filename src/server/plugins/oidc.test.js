import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { createServer } from '~/src/server/index.js'

describe('oidc plugin', () => {
  /** @type {Server} */
  let server

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
  })

  it('serves the discovery document with issuer-derived endpoints', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration'
    })

    expect(res.statusCode).toBe(200)
    const doc = JSON.parse(res.payload)
    expect(doc.issuer).toBe('http://localhost:3011')
    expect(doc.authorization_endpoint).toBe('http://localhost:3011/auth')
    expect(doc.token_endpoint).toBe('http://localhost:3011/token')
  })

  it('builds endpoint URLs from the issuer, not from the caller headers', async () => {
    // A caller who could name the origin could name the jwks_uri, and a
    // relying party that resolved keys from it would accept tokens signed by
    // whoever answered there
    const res = await server.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration',
      headers: {
        host: 'evil.example.com',
        'x-forwarded-host': 'evil.example.com',
        'x-forwarded-proto': 'https'
      }
    })

    expect(res.statusCode).toBe(200)
    const doc = JSON.parse(res.payload)
    expect(doc.issuer).toBe('http://localhost:3011')
    expect(doc.jwks_uri).toBe('http://localhost:3011/jwks')
    expect(doc.authorization_endpoint).toBe('http://localhost:3011/auth')
    expect(doc.token_endpoint).toBe('http://localhost:3011/token')
    expect(doc.userinfo_endpoint).toBe('http://localhost:3011/me')
  })

  it('logs the host it ignored, so a proxy that stops overwriting it shows up', async () => {
    const warn = jest.spyOn(logger, 'warn').mockReturnValue(undefined)

    await server.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration',
      headers: { 'x-forwarded-host': 'evil.example.com' }
    })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[forwardedHostIgnored]')
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('evil.example.com')
    )
  })

  it('stays quiet when the load balancer sends the issuer host', async () => {
    const warn = jest.spyOn(logger, 'warn').mockReturnValue(undefined)

    await server.inject({
      method: 'GET',
      url: '/.well-known/openid-configuration',
      headers: { 'x-forwarded-host': 'localhost:3011' }
    })

    expect(warn).not.toHaveBeenCalled()
  })

  it('serves jwks with only the public key material', async () => {
    const res = await server.inject({ method: 'GET', url: '/jwks' })

    expect(res.statusCode).toBe(200)
    const { keys } = JSON.parse(res.payload)
    expect(keys[0].kty).toBe('EC')
    expect(keys[0].alg).toBe('ES256')
    // `d` is the private component — publishing it would hand out the
    // ability to mint ID tokens
    expect(keys[0].d).toBeUndefined()
  })

  describe('security headers', () => {
    // The provider replies straight down the socket, so these headers are
    // the ones written in the bridge. Each path is a protocol response that
    // hapi never gets to decorate
    const baseline = {
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-frame-options': 'DENY',
      'x-xss-protection': '1; mode=block',
      'x-content-type-options': 'nosniff',
      'x-download-options': 'noopen',
      'content-security-policy': expect.stringContaining(
        "frame-ancestors 'none'"
      )
    }

    // Named here rather than imported, so dropping one from the bridge shows
    // up as a failure instead of a shorter comparison
    const securityHeaderNames = [
      'content-security-policy',
      'strict-transport-security',
      'x-content-type-options',
      'x-download-options',
      'x-frame-options',
      'x-xss-protection'
    ]

    /**
     * @param {Record<string, unknown>} headers
     */
    const securityHeaders = (headers) =>
      Object.fromEntries(
        securityHeaderNames.map((name) => [
          name,
          // blankie mints a script nonce per rendered page; the rest of the
          // policy is what both sides must agree on
          String(headers[name]).replace(/ 'nonce-[^']*'/g, '')
        ])
      )

    it.each(['/jwks', '/.well-known/openid-configuration', '/auth/NOSUCHUID'])(
      'sends the baseline on %s',
      async (url) => {
        const res = await server.inject({ method: 'GET', url })

        expect(res.headers).toMatchObject(baseline)
      }
    )

    it('is the baseline a rendered page gets, which hapi sets itself', async () => {
      // The other half of the same guarantee: these headers are only worth
      // copying onto protocol responses while the routed ones still carry
      // them
      const res = await server.inject({ method: 'GET', url: '/' })

      expect(res.headers).toMatchObject(baseline)
    })

    it('sends a protocol response what a routed one gets, header for header', async () => {
      const protocolRes = await server.inject({ method: 'GET', url: '/jwks' })
      const pageRes = await server.inject({ method: 'GET', url: '/' })

      expect(securityHeaders(protocolRes.headers)).toEqual(
        securityHeaders(pageRes.headers)
      )
    })
  })

  it('still renders the GDS 404 for unknown routes', async () => {
    const res = await server.inject({ method: 'GET', url: '/unknown-page' })

    expect(res.statusCode).toBe(404)
    expect(res.payload).toContain('Page not found')
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
