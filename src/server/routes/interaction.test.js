import { errors } from 'oidc-provider'

import { createServer } from '~/src/server/index.js'
import * as identityApi from '~/src/server/repositories/identity-api.js'

jest.mock('~/src/server/repositories/identity-api.js', () => ({
  requestOtp: jest.fn(),
  verifyOtp: jest.fn(),
  completeSignup: jest.fn(),
  getAccount: jest.fn()
}))

describe('interaction pages', () => {
  /** @type {import('@hapi/hapi').Server} */
  let server
  /** @type {jest.SpyInstance} */
  let detailsSpy
  /** @type {jest.SpyInstance} */
  let finishedSpy

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    const provider = server.app.oidcProvider
    detailsSpy = jest.spyOn(provider, 'interactionDetails').mockResolvedValue(
      /** @type {never} */ ({
        uid: 'uid-1',
        prompt: { name: 'login' },
        params: {},
        session: undefined
      })
    )
    finishedSpy = jest
      .spyOn(provider, 'interactionFinished')
      .mockImplementation(
        /** @type {never} */ (
          /**
           * @param {unknown} _req
           * @param {import('node:http').ServerResponse} res
           */
          (_req, res) => {
            // the real provider writes the resume redirect itself; the handler
            // then returns h.abandon, so the mock must end the response
            res.writeHead(302, { Location: '/auth/uid-1' })
            res.end()
            return Promise.resolve()
          }
        )
      )
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  /**
   * Fetches a page and extracts the crumb from the form + cookie jar
   * @param {string} url
   */
  async function getWithCrumb(url) {
    const res = await server.inject({ method: 'GET', url })
    const crumb = /name="crumb" value="([^"]+)"/.exec(res.payload)?.[1]
    const setCookies = /** @type {string[] | string | undefined} */ (
      res.headers['set-cookie']
    )
    const cookie = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .filter(Boolean)
      .map((c) => String(c).split(';')[0])
      .join('; ')
    return { res, crumb, cookie }
  }

  it('GET renders the email page for a login prompt', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/interaction/uid-1'
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('Enter your email address')
  })

  it('GET renders the timed-out page when the interaction is dead', async () => {
    detailsSpy.mockRejectedValue(
      new errors.SessionNotFound('session not found')
    )

    const res = await server.inject({
      method: 'GET',
      url: '/interaction/uid-1'
    })

    expect(res.statusCode).toBe(410)
    expect(res.payload).toContain('For your security, we ended your sign in')
  })

  it('GET surfaces a 500, not a timeout, when the interaction lookup fails', async () => {
    detailsSpy.mockRejectedValue(new Error('persistence tier unreachable'))

    const res = await server.inject({
      method: 'GET',
      url: '/interaction/uid-1'
    })

    expect(res.statusCode).toBe(500)
    expect(res.payload).toContain('Sorry, there is a problem with the service')
    expect(res.payload).not.toContain('we ended your sign in')
  })

  it('POST email requests a code and redirects to the code page', async () => {
    jest.mocked(identityApi.requestOtp).mockResolvedValue(undefined)
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1')

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/email',
      headers: { cookie },
      payload: { crumb, email: 'Citizen@Example.com' }
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      '/interaction/uid-1/code?email=Citizen%40Example.com'
    )
    expect(identityApi.requestOtp).toHaveBeenCalledWith({
      uid: 'uid-1',
      email: 'Citizen@Example.com'
    })
  })

  it('POST email re-renders with a GDS error for an invalid email', async () => {
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1')

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/email',
      headers: { cookie },
      payload: { crumb, email: 'not-an-email' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('There is a problem')
    expect(identityApi.requestOtp).not.toHaveBeenCalled()
  })

  it('POST email without a crumb is rejected', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/email',
      payload: { email: 'a@b.com' }
    })

    expect(res.statusCode).toBe(403)
  })

  it('POST code finishes the interaction when signed in', async () => {
    jest
      .mocked(identityApi.verifyOtp)
      .mockResolvedValue({ status: 'signed-in', accountId: 'acc-1' })
    const { crumb, cookie } = await getWithCrumb(
      '/interaction/uid-1/code?email=a%40b.com'
    )

    await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/code',
      headers: { cookie },
      payload: { crumb, code: '123456', email: 'a@b.com' }
    })

    expect(finishedSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { login: { accountId: 'acc-1' } },
      { mergeWithLastSubmission: false }
    )
  })

  it('POST code redirects to the phone page when phone-required', async () => {
    jest
      .mocked(identityApi.verifyOtp)
      .mockResolvedValue({ status: 'phone-required' })
    const { crumb, cookie } = await getWithCrumb(
      '/interaction/uid-1/code?email=a%40b.com'
    )

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/code',
      headers: { cookie },
      payload: { crumb, code: '123456', email: 'a@b.com' }
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/interaction/uid-1/phone')
  })

  it('POST code redirects to the expiration page on expiry', async () => {
    jest.mocked(identityApi.verifyOtp).mockResolvedValue({ status: 'expired' })
    const { crumb, cookie } = await getWithCrumb(
      '/interaction/uid-1/code?email=a%40b.com'
    )

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/code',
      headers: { cookie },
      payload: { crumb, code: '123456', email: 'a@b.com' }
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(
      '/interaction/uid-1/expired?email=a%40b.com'
    )
  })

  it('POST code re-renders with an error on an invalid code', async () => {
    jest.mocked(identityApi.verifyOtp).mockResolvedValue({ status: 'invalid' })
    const { crumb, cookie } = await getWithCrumb(
      '/interaction/uid-1/code?email=a%40b.com'
    )

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/code',
      headers: { cookie },
      payload: { crumb, code: '000000', email: 'a@b.com' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('There is a problem')
  })

  it('POST a malformed or empty code re-renders without calling the API', async () => {
    const { crumb, cookie } = await getWithCrumb(
      '/interaction/uid-1/code?email=a%40b.com'
    )

    for (const code of ['12345', 'abc123', '']) {
      const res = await server.inject({
        method: 'POST',
        url: '/interaction/uid-1/code',
        headers: { cookie },
        payload: { crumb, code, email: 'a@b.com' }
      })

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain('There is a problem')
    }
    expect(identityApi.verifyOtp).not.toHaveBeenCalled()
  })

  it('POST phone finishes the interaction on success', async () => {
    jest
      .mocked(identityApi.completeSignup)
      .mockResolvedValue({ status: 'signed-in', accountId: 'acc-2' })
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1/phone')

    await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/phone',
      headers: { cookie },
      payload: { crumb, phone: '07911 123456' }
    })

    expect(finishedSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { login: { accountId: 'acc-2' } },
      { mergeWithLastSubmission: false }
    )
  })

  it('POST a non-number phone re-renders without calling the API', async () => {
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1/phone')

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/phone',
      headers: { cookie },
      payload: { crumb, phone: 'not a number' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('There is a problem')
    expect(identityApi.completeSignup).not.toHaveBeenCalled()
  })

  it('POST phone re-renders with an error on an invalid phone', async () => {
    jest
      .mocked(identityApi.completeSignup)
      .mockResolvedValue({ status: 'invalid-phone' })
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1/phone')

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/phone',
      headers: { cookie },
      payload: { crumb, phone: '020 7946 0000' }
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('There is a problem')
  })

  it('POST phone bounces to the email page on an out-of-order call', async () => {
    jest
      .mocked(identityApi.completeSignup)
      .mockResolvedValue({ status: 'invalid' })
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1/phone')

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/phone',
      headers: { cookie },
      payload: { crumb, phone: '07911 123456' }
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/interaction/uid-1')
  })

  it('GET expired renders the prototype page with a same-uid restart link', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/interaction/uid-1/expired?email=a%40b.com'
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('Your security code has expired')
    expect(res.payload).toContain('href="/interaction/uid-1"')
  })

  it('auto-grants consent prompts', async () => {
    detailsSpy.mockResolvedValue(
      /** @type {never} */ ({
        uid: 'uid-1',
        prompt: { name: 'consent' },
        params: { client_id: 'runner', scope: 'openid email' },
        session: { accountId: 'acc-1' }
      })
    )
    const provider = server.app.oidcProvider
    const saveSpy = jest.fn().mockResolvedValue('grant-1')
    const addScopeSpy = jest.fn()
    class FakeGrant {
      addOIDCScope = addScopeSpy
      save = saveSpy
    }
    // Grant is a getter on the provider — swap it via defineProperty
    Object.defineProperty(provider, 'Grant', {
      value: FakeGrant,
      configurable: true
    })

    await server.inject({ method: 'GET', url: '/interaction/uid-1' })

    // restore the prototype getter
    // @ts-expect-error -- delete own property to fall back to the class getter
    delete provider.Grant

    expect(addScopeSpy).toHaveBeenCalledWith('openid email')
    expect(finishedSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { consent: { grantId: 'grant-1' } },
      { mergeWithLastSubmission: true }
    )
  })
})
