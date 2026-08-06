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
      url: '/.well-known/openid-configuration',
      // endpoint URLs derive from the Host header (proxy-trusting provider)
      headers: { host: 'localhost:3011' }
    })

    expect(res.statusCode).toBe(200)
    const doc = JSON.parse(res.payload)
    expect(doc.issuer).toBe('http://localhost:3011')
    expect(doc.authorization_endpoint).toBe('http://localhost:3011/auth')
    expect(doc.token_endpoint).toBe('http://localhost:3011/token')
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
