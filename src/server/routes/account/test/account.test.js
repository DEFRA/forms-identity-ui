import { createServer } from '~/src/server/index.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { renderResponse } from '~/test/helpers/component-helpers.js'

const account = {
  id: 'acc-id',
  email: 'email@test.com',
  phone: '+447507123456'
}

/** The registered client, as the provider returns it */
const runnerClient = {
  redirectUris: ['http://localhost:3009/callback'],
  initiateLoginUri: 'http://localhost:3009/auth/initiate'
}

jest.mock('~/src/server/lib/identity-api.js', () => ({
  requestOtpViaEmail: jest.fn(),
  requestOtpViaSms: jest.fn(),
  verifyOtp: jest.fn(),
  completeSignup: jest.fn(),
  getAccount: jest.fn(),
  getOtpTarget: jest.fn(),
  getOtp: jest.fn(),
  deleteAccount: jest.fn()
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
  strategy: 'citizen-session',
  artifacts: { sessionUid: 'sess-id-1' },
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
    jest
      .spyOn(server.app.oidcProvider.Client, 'find')
      .mockImplementation((id) =>
        Promise.resolve(
          id === 'runner' ? /** @type {never} */ (runnerClient) : undefined
        )
      )
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
      url: '/account?client_id=runner&returnUrl=http://localhost:3009/homepage/preview/draft/form-slug'
    })

    expect(response.statusCode).toBe(200)
    expect(container.getByText('a@b.com')).toBeInTheDocument()
    expect(container.getByText('07911 123456')).toBeInTheDocument()
    const $link = container.getByRole('link', { name: 'Back' })
    expect($link.getAttribute('href')).toBe(
      'http://localhost:3009/homepage/preview/draft/form-slug'
    )
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

  test.each([
    {
      reason: 'is not on an origin of the client',
      url: '/account?client_id=runner&returnUrl=https://other.example/page'
    },
    {
      reason: 'names no client',
      url: '/account?returnUrl=http://localhost:3009/return-page'
    }
  ])('shows no Back link for a return url that $reason', async ({ url }) => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue(account)

    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url
    })

    expect(response.statusCode).toBe(200)
    expect(container.queryByRole('link', { name: 'Back' })).toBeNull()
  })

  describe('with no signed-in session', () => {
    beforeEach(() => {
      sessionSpy.mockResolvedValue(
        /** @type {never} */ ({ accountId: undefined })
      )
    })

    /**
     * @param {string | string[] | undefined} location
     */
    function signInRedirect(location) {
      const url = new URL(String(location))

      return {
        endpoint: `${url.origin}${url.pathname}`,
        iss: url.searchParams.get('iss'),
        target: url.searchParams.get('target_link_uri')
      }
    }

    test('sends the user to the client to sign in, and back to the account page', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/account?client_id=runner&returnUrl=http://localhost:3009/return-page'
      })

      expect(response.statusCode).toBe(302)
      expect(signInRedirect(response.headers.location)).toEqual({
        endpoint: 'http://localhost:3009/auth/initiate',
        iss: 'http://localhost:3011',
        target:
          'http://localhost:3011/account?client_id=runner&returnUrl=http%3A%2F%2Flocalhost%3A3009%2Freturn-page'
      })
      expect(identityApi.getAccount).not.toHaveBeenCalled()
    })

    test('leaves out a return url that is not on an origin of the client', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/account?client_id=runner&returnUrl=https://other.example/page'
      })

      expect(response.statusCode).toBe(302)
      expect(signInRedirect(response.headers.location).target).toBe(
        'http://localhost:3011/account?client_id=runner'
      )
    })

    test.each([
      {
        reason: 'the request names a client that is not registered',
        url: '/account?client_id=unknown&returnUrl=http://localhost:3009/return-page'
      },
      {
        reason: 'the request names a client more than once',
        url: '/account?client_id=runner&client_id=runner'
      },
      { reason: 'the request names no client', url: '/account/change-email' }
    ])(
      'tells the user to sign in again from their service when $reason',
      async ({ url }) => {
        const { container, response } = await renderResponse(server, {
          method: 'GET',
          url
        })

        expect(response.statusCode).toBe(401)
        expect(
          container.getByRole('heading', { level: 1, name: 'Sign in again' })
        ).toBeInTheDocument()
        expect(server.app.oidcProvider.Client.find).not.toHaveBeenCalled()
      }
    )

    describe('after an earlier visit from the client', () => {
      /** @type {string} */
      let cookie

      beforeEach(async () => {
        sessionSpy.mockResolvedValueOnce(
          /** @type {never} */ ({ accountId: 'acc-1' })
        )
        jest.mocked(identityApi.getAccount).mockResolvedValue(account)

        const visit = await server.inject({
          method: 'GET',
          url: '/account?client_id=runner&returnUrl=http://localhost:3009/return-page'
        })

        cookie = [visit.headers['set-cookie']]
          .flat()
          .map((value) => String(value).split(';')[0])
          .join('; ')
      })

      test.each([
        '/account/change-email',
        '/account/change-email/phone-sent-code',
        '/account/delete-account'
      ])(
        'sends the user to that client to sign in, and back to the account page, from %s',
        async (url) => {
          const response = await server.inject({
            method: 'GET',
            url,
            headers: { cookie }
          })

          expect(response.statusCode).toBe(302)
          expect(signInRedirect(response.headers.location).target).toBe(
            'http://localhost:3011/account?client_id=runner&returnUrl=http%3A%2F%2Flocalhost%3A3009%2Freturn-page'
          )
        }
      )
    })
  })

  test('is unauthorized when the session account no longer exists, and does not start a sign in', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'gone' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue(null)

    const { response } = await renderResponse(server, {
      method: 'GET',
      url: '/account?client_id=runner&returnUrl=http://localhost:3009/return-page'
    })

    expect(response.statusCode).toBe(401)
  })

  test('redirects to the expired code page when the phone code has expired or is invalid', async () => {
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

    const { crumb, cookie } = await getWithCrumb('/account/change-email')

    const { response } = await renderResponse(server, {
      method: 'POST',
      url: '/account/change-email/phone-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe(
      '/account/change-email/code/expired/sms'
    )
  })

  test('redirects to the first page when no phone OTP but the user has hit a later page (new email)', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })
    jest.mocked(identityApi.getOtp).mockResolvedValueOnce(null)

    const { crumb, cookie } = await getWithCrumb('/account/change-email')

    const { response } = await renderResponse(server, {
      method: 'POST',
      url: '/account/change-email/enter-email',
      payload: { crumb, email: 'new-email@test.com' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/change-email')
  })

  test('redirects to the first page when no phone OTP but the user has hit a later page (email code)', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })
    jest.mocked(identityApi.getOtp).mockResolvedValueOnce(null)

    const { crumb, cookie } = await getWithCrumb('/account/change-email')

    const { response } = await renderResponse(server, {
      method: 'GET',
      url: '/account/change-email/email-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/change-email')
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

    const { crumb, cookie } = await getWithCrumb('/account/change-email')

    const { response } = await renderResponse(server, {
      method: 'GET',
      url: '/account/change-email/email-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/change-email')
  })

  test('redirects to the first page when no email OTP but the user POSTs a later page (email code)', async () => {
    sessionSpy.mockResolvedValue(/** @type {never} */ ({ accountId: 'acc-1' }))
    jest.mocked(identityApi.getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com',
      phone: '07911 123456'
    })
    jest.mocked(identityApi.getOtp).mockResolvedValueOnce(null)

    const { crumb, cookie } = await getWithCrumb('/account/change-email')

    const { response } = await renderResponse(server, {
      method: 'POST',
      url: '/account/change-email/email-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/account/change-email')
  })

  test('deletes the account, revokes its grants and destroys the session', async () => {
    jest.mocked(identityApi.getOtp).mockResolvedValue({
      consumed: false,
      verified: true,
      target: 'email@test.com'
    })
    jest
      .mocked(identityApi.verifyOtp)
      .mockResolvedValue(/** @type {never} */ ({ status: 'valid' }))
    jest
      .mocked(identityApi.deleteAccount)
      .mockResolvedValue(/** @type {never} */ ({ outcome: 'complete' }))

    const session = {
      authorizations: {
        client1: { grantId: 'grant-1' },
        client2: { grantId: 'grant-2' },
        client3: {}
      },
      destroy: jest.fn()
    }
    const findByUidSpy = jest
      .spyOn(server.app.oidcProvider.Session, 'findByUid')
      .mockResolvedValue(/** @type {never} */ (session))
    const revokeByGrantIdSpy = jest
      .spyOn(server.app.oidcProvider.AccessToken, 'revokeByGrantId')
      .mockResolvedValue()

    const { crumb, cookie } = await getWithCrumb('/account/delete-account')
    const { response } = await renderResponse(server, {
      method: 'POST',
      url: '/account/delete-account/email-code',
      payload: { crumb, code: '123456' },
      headers: { cookie },
      auth
    })

    expect(response.statusCode).toBe(200)
    expect(identityApi.deleteAccount).toHaveBeenCalledWith(
      { uid: 'sess-id-1', accountId: 'acc-id' },
      'token-1'
    )
    expect(revokeByGrantIdSpy).toHaveBeenCalledTimes(2)
    expect(revokeByGrantIdSpy).toHaveBeenCalledWith('grant-1')
    expect(revokeByGrantIdSpy).toHaveBeenCalledWith('grant-2')
    expect(session.destroy).toHaveBeenCalled()

    findByUidSpy.mockRestore()
    revokeByGrantIdSpy.mockRestore()
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 * @import { ServerInjectOptions } from '@hapi/hapi'
 */
