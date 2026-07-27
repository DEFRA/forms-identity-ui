import { createServer } from '~/src/server/index.js'

describe('Health check route', () => {
  /** @type {Server} */
  let server

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
  })

  test('/health route response is correct', async () => {
    const { result, statusCode } = await server.inject({
      method: 'GET',
      url: '/health'
    })

    expect(statusCode).toBe(200)
    expect(result).toMatchObject({
      message: 'success'
    })
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
