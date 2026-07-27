import { config } from '~/src/config/index.js'

describe('Config', () => {
  test('validates against the convict schema', () => {
    expect(() => config.validate({ allowed: 'strict' })).not.toThrow()
  })

  test('provides expected test environment defaults', () => {
    expect(config.get('serviceName')).toBe('forms-identity-ui')
    expect(config.get('port')).toBe(3002)
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
})
