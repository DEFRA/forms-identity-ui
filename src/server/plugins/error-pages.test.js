import Boom from '@hapi/boom'

import { createServer } from '~/src/server/index.js'

describe('error pages', () => {
  /** @type {Server} */
  let server
  /** @type {jest.Mock} */
  let logError

  beforeAll(async () => {
    server = await createServer()

    server.route([
      {
        method: 'GET',
        path: '/test-forbidden',
        handler() {
          throw Boom.forbidden()
        }
      },
      {
        method: 'GET',
        path: '/test-server-error',
        handler() {
          throw Boom.badImplementation()
        }
      }
    ])

    // hapi-pino attaches request.logger during its own onRequest extension,
    // so this one (registered later) can swap in a spy the plugin will use
    server.ext('onRequest', (request, h) => {
      request.logger = /** @type {never} */ ({
        error: (/** @type {unknown[]} */ ...args) => logError(...args),
        info: () => undefined,
        warn: () => undefined,
        debug: () => undefined
      })
      return h.continue
    })

    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    logError = jest.fn()
  })

  test('an expected client error is not logged at error level', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/test-forbidden'
    })

    expect(response.statusCode).toBe(403)
    expect(logError).not.toHaveBeenCalled()
  })

  test('a server error is logged at error level', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/test-server-error'
    })

    expect(response.statusCode).toBe(500)
    expect(logError).toHaveBeenCalled()
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
