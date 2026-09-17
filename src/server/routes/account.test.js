import { createServer } from '~/src/server/index.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { renderResponse } from '~/test/helpers/component-helpers.js'

jest.mock('~/src/server/lib/identity-api.js', () => ({
  requestOtpViaEmail: jest.fn(),
  requestOtpViaSms: jest.fn(),
  verifyOtp: jest.fn(),
  completeSignup: jest.fn(),
  getAccount: jest.fn(),
  getOtpEmail: jest.fn()
}))

jest.mock('~/src/server/lib/service-token.js', () => ({
  ...jest.requireActual('~/src/server/lib/service-token.js'),
  getServiceToken: jest.fn()
}))

describe('/account', () => {
  /** @type {Server} */
  let server
  /** @type {jest.SpyInstance} */
  let sessionSpy

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    jest.mocked(getServiceToken).mockResolvedValue('token-1')
    sessionSpy = jest.spyOn(server.app.oidcProvider.Session, 'get')
  })

  test('renders the signed-in account with their email and phone', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest
      .mocked(identityApi.getAccount)
      .mockResolvedValue({
        id: 'acc-1',
        email: 'a@b.com',
        phone: '07911 123456'
      })

    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url: '/account'
    })

    expect(response.statusCode).toBe(200)
    expect(container.getByText('a@b.com')).toBeInTheDocument()
    expect(container.getByText('07911 123456')).toBeInTheDocument()
  })

  test('is unauthorized when there is no signed-in session', async () => {
    sessionSpy.mockResolvedValue(
      /** @type {never} */ ({ accountId: undefined })
    )

    const { response } = await renderResponse(server, {
      method: 'GET',
      url: '/account'
    })

    expect(response.statusCode).toBe(401)
    expect(identityApi.getAccount).not.toHaveBeenCalled()
  })

  test('is unauthorized when the session account no longer exists', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'gone' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue(null)

    const { response } = await renderResponse(server, {
      method: 'GET',
      url: '/account'
    })

    expect(response.statusCode).toBe(401)
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
