import { config } from '~/src/config/index.js'

describe('Config', () => {
  test('session cookie password meets minimum length', () => {
    expect(config.get('session.cookie.password').length).toBeGreaterThanOrEqual(
      32
    )
  })
})
