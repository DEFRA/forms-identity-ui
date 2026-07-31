import { config } from '~/src/config/index.js'

describe('Config', () => {
  test('validates against the convict schema', () => {
    expect(() => config.validate({ allowed: 'strict' })).not.toThrow()
  })

  test('provides expected test environment defaults', () => {
    expect(config.get('serviceName')).toBe('forms-identity-ui')
    expect(config.get('port')).toBe(3011)
    expect(config.get('isTest')).toBe(true)
    expect(config.get('isProduction')).toBe(false)
    expect(config.get('session.cache.engine')).toBe('memory')
    expect(config.get('session.cache.name')).toBe('session')
    expect(config.get('redis.keyPrefix')).toBe('forms-identity-ui:')
    expect(config.get('tracing.header')).toBe('x-cdp-request-id')
  })

  test('session cookie password meets minimum length', () => {
    expect(config.get('session.cookie.password').length).toBeGreaterThanOrEqual(
      32
    )
  })

  test('defaults the OIDC issuer and API url to the local ports', () => {
    expect(config.get('oidc.issuer')).toBe('http://localhost:3011')
    expect(config.get('identityApi.url')).toBe('http://localhost:3010')
    expect(config.get('oidc.runnerRedirectUris')).toBe(
      'http://localhost:3009/callback,http://localhost:3000/callback'
    )
  })

  test('reads the OIDC secrets from the environment', () => {
    expect(config.get('oidc.jwks')).toBe(process.env.OIDC_JWKS)
    expect(config.get('oidc.cookieKeys')).toBe(process.env.OIDC_COOKIE_KEYS)
    expect(config.get('oidc.clientSecret')).toBe(process.env.OIDC_CLIENT_SECRET)
    expect(config.get('oidc.cookieSecure')).toBe(false)
  })
})
