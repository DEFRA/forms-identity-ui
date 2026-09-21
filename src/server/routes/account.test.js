import { createServer } from '~/src/server/index.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { renderResponse } from '~/test/helpers/component-helpers.js'

const account = {
  id: 'acc-id',
  email: 'email@test.com',
  phone: '+447507123456'
}

jest.mock('~/src/server/lib/identity-api.js', () => ({
  requestOtpViaEmail: jest.fn(),
  requestOtpViaSms: jest.fn(),
  verifyOtp: jest.fn(),
  completeSignup: jest.fn(),
  getAccount: jest.fn(),
  getOtpTarget: jest.fn(),
  getOtp: jest.fn()
}))

jest.mock('~/src/server/lib/service-token.js', () => ({
  ...jest.requireActual('~/src/server/lib/service-token.js'),
  getServiceToken: jest.fn()
}))

/**
 * Request auth for Hapi `server.inject()` — hapi's own credentials type is
 * a nominal placeholder, so the real (route-defined) shape needs a cast
 * @satisfies {ServerInjectOptions['auth']}
 */
const auth = {
  strategy: 'citizen-ui-session',
  artifacts: {},
  credentials: /** @type {never} */ (account)
}

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

  /**
   * Fetches a page as the signed-in account and extracts the crumb from
   * the form + cookie jar, same as interaction.test.js's helper of the
   * same name
   * @param {string} url
   */
  async function getWithCrumb(url) {
    const res = await server.inject({ method: 'GET', url, auth })
    const crumb = /name="crumb" value="([^"]+)"/.exec(res.payload)?.[1]
    const setCookies = /** @type {string[] | string | undefined} */ (
      res.headers['set-cookie']
    )
    const cookie = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .filter(Boolean)
      .map((c) => String(c).split(';')[0])
      .join('; ')
    return { crumb, cookie }
  }

  test('renders the signed-in account with their email and phone', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
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

  test('renders the signed-in account and stores the return url', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })

    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url: '/account?returnUrl=http://localhost:3009/return-page'
    })

    expect(response.statusCode).toBe(200)
    expect(container.getByText('a@b.com')).toBeInTheDocument()
    expect(container.getByText('07911 123456')).toBeInTheDocument()
    const $link = container.getByRole('link', { name: 'Back' })
    expect($link.getAttribute('href')).toBe('http://localhost:3009/return-page')
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

  test('redirects to an error page that explains that the code has expired or is invalid', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })
    jest
      .mocked(identityApi.verifyOtp)
      .mockResolvedValue(
        /** @type {never} */ ({ status: 'invalid-code-consumed-or-expired' })
      )

    const { crumb, cookie } = await getWithCrumb('/account/uid-1/change-email')

    const { response } = await renderResponse(server, {
      method: 'POST',
      url: '/account/uid-1/phone-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/uid-1/code/expired')
  })

  test('redirects to the first page when no phone OTP but the user has hit a later page (new email)', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })
    jest.mocked(identityApi.getOtp).mockResolvedValueOnce(null)

    const { crumb, cookie } = await getWithCrumb('/account/uid-1/change-email')

    const { response } = await renderResponse(server, {
      method: 'POST',
      url: '/account/uid-1/new-email',
      payload: { crumb, email: 'new-email@test.com' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/uid-1/change-email')
  })

  test('redirects to the first page when no phone OTP but the user has hit a later page (email code)', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })
    jest.mocked(identityApi.getOtp).mockResolvedValueOnce(null)

    const { crumb, cookie } = await getWithCrumb('/account/uid-1/change-email')

    const { response } = await renderResponse(server, {
      method: 'GET',
      url: '/account/uid-1/email-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/uid-1/change-email')
  })

  test('redirects to the first page when no email OTP but the user has hit a later page (email code)', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })
    jest.mocked(identityApi.getOtp).mockResolvedValueOnce({
      consumed: false,
      verified: true,
      target: '+447507123456'
    })
    jest.mocked(identityApi.getOtp).mockResolvedValueOnce(null)

    const { crumb, cookie } = await getWithCrumb('/account/uid-1/change-email')

    const { response } = await renderResponse(server, {
      method: 'GET',
      url: '/account/uid-1/email-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/uid-1/change-email')
  })

  test('redirects to the first page when no email OTP but the user POSTs a later page (email code)', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })
    jest.mocked(identityApi.getOtp).mockResolvedValueOnce(null)

    const { crumb, cookie } = await getWithCrumb('/account/uid-1/change-email')

    const { response } = await renderResponse(server, {
      method: 'POST',
      url: '/account/uid-1/email-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/uid-1/change-email')
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 * @import { ServerInjectOptions } from '@hapi/hapi'
 */
