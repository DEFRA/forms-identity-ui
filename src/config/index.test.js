import { config } from '~/src/config/index.js'

describe('Config', () => {
  test('session cookie password meets minimum length', () => {
    expect(config.get('session.cookie.password').length).toBeGreaterThanOrEqual(
      32
    )
  })

  describe.each(
    /** @type {const} */ ([
      ['oidc.cookieKeys', 'OIDC_COOKIE_KEYS'],
      ['oidc.resourceServers', 'OIDC_RESOURCE_SERVERS'],
      ['oidc.runnerRedirectUris', 'OIDC_RUNNER_REDIRECT_URIS'],
      [
        'oidc.runnerPostLogoutRedirectUris',
        'OIDC_RUNNER_POST_LOGOUT_REDIRECT_URIS'
      ]
    ])
  )('%s', (key, env) => {
    const original = process.env[env]

    afterEach(() => {
      process.env[env] = original
      jest.resetModules()
    })

    test('reads a comma-separated value as a trimmed list', async () => {
      process.env[env] = ' a ,, b ,'
      jest.resetModules()

      const { config: fresh } = await import('~/src/config/index.js')

      expect(fresh.get(key)).toEqual(['a', 'b'])
    })

    test('refuses to load without an entry', async () => {
      process.env[env] = ' , '
      jest.resetModules()

      await expect(import('~/src/config/index.js')).rejects.toThrow(
        'must be a comma-separated list with at least one entry'
      )
    })
  })
})
