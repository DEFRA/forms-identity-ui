import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { createServer } from '~/src/server/index.js'

describe('oidc plugin', () => {
  /** @type {import('@hapi/hapi').Server} */
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

  it('still renders the GDS 404 for unknown routes', async () => {
    const res = await server.inject({ method: 'GET', url: '/unknown-page' })

    expect(res.statusCode).toBe(404)
    expect(res.payload).toContain('Page not found')
  })
})
