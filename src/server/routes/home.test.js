import { createServer } from '~/src/server/index.js'

describe('Home route', () => {
  /** @type {Server} */
  let server

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
  })

  test('/ route renders the service name', async () => {
    const { payload, statusCode } = await server.inject({
      method: 'GET',
      url: '/'
    })

    expect(statusCode).toBe(200)
    expect(payload).toContain('Sign in to Defra Forms')
  })

  test('unknown route renders the error page', async () => {
    const { payload, statusCode } = await server.inject({
      method: 'GET',
      url: '/unknown-page'
    })

    expect(statusCode).toBe(404)
    expect(payload).toContain('Page not found')
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
