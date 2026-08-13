import { createServer } from '~/src/server/index.js'
import { renderResponse } from '~/test/helpers/component-helpers.js'

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
    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url: '/'
    })

    expect(response.statusCode).toBe(200)
    expect(
      container.getByRole('heading', {
        name: 'You cannot sign in from this page',
        level: 1
      })
    ).toBeInTheDocument()
    expect(
      container.getByRole('heading', { name: 'What you need to do', level: 2 })
    ).toBeInTheDocument()
    const $steps = container.getAllByRole('listitem')
    expect($steps[0]).toHaveTextContent(
      'Go back to the website, app, or form you were using.'
    )
  })

  test('unknown route renders the error page', async () => {
    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url: '/unknown-page'
    })

    expect(response.statusCode).toBe(404)
    expect(
      container.getByRole('heading', { name: 'Page not found', level: 1 })
    ).toBeInTheDocument()
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
