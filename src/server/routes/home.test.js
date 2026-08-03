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

  test('/ tells a lost user to go back to where they came from', async () => {
    const { payload, statusCode } = await server.inject({
      method: 'GET',
      url: '/'
    })

    expect(statusCode).toBe(200)
    expect(payload).toContain('You cannot sign in from this page')
    expect(payload).toContain('What you need to do')
    expect(payload).toContain(
      'Go back to the website, app, or form you were using.'
    )
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
