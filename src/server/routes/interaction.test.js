import { errors } from 'oidc-provider'

import { createServer } from '~/src/server/index.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { assertInteractionRoutesGated } from '~/src/server/routes/interaction.js'
import { renderResponse } from '~/test/helpers/component-helpers.js'

jest.mock('~/src/server/lib/identity-api.js', () => ({
  requestOtp: jest.fn(),
  verifyOtp: jest.fn(),
  completeSignup: jest.fn(),
  getAccount: jest.fn(),
  getOtpEmail: jest.fn()
}))

describe('interaction pages', () => {
  /** @type {Server} */
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
    jest.mocked(identityApi.getOtpEmail).mockResolvedValue('a@b.com')
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
           * @param {ServerResponse} res
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
    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url: '/interaction/uid-1'
    })

    expect(response.statusCode).toBe(200)
    const $heading = container.getByRole('heading', {
      name: 'Enter your email address',
      level: 1
    })
    expect($heading).toBeInTheDocument()
    expect(
      container.getByRole('textbox', { name: 'Enter your email address' })
    ).toBeInTheDocument()
    expect(
      container.getByRole('button', { name: 'Continue' })
    ).toBeInTheDocument()
  })

  it('GET renders the timed-out page when the interaction is dead', async () => {
    detailsSpy.mockRejectedValue(
      new errors.SessionNotFound('session not found')
    )

    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url: '/interaction/uid-1'
    })

    expect(response.statusCode).toBe(410)
    const $heading = container.getByRole('heading', {
      name: 'For your security, we ended your sign in',
      level: 1
    })
    expect($heading).toBeInTheDocument()
  })

  it('GET surfaces a 500, not a timeout, when the interaction lookup fails', async () => {
    detailsSpy.mockRejectedValue(new Error('persistence tier unreachable'))

    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url: '/interaction/uid-1'
    })

    expect(response.statusCode).toBe(500)
    const $heading = container.getByRole('heading', {
      name: 'Sorry, there is a problem with the service',
      level: 1
    })
    expect($heading).toBeInTheDocument()
    expect(
      container.queryByRole('heading', { name: /we ended your sign in/ })
    ).not.toBeInTheDocument()
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
    expect(res.headers.location).toBe('/interaction/uid-1/code')
    expect(identityApi.requestOtp).toHaveBeenCalledWith({
      uid: 'uid-1',
      email: 'Citizen@Example.com'
    })
  })

  it('POST email re-renders with a GDS error for an invalid email', async () => {
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1')

    const { container, response } = await renderResponse(server, {
      method: 'POST',
      url: '/interaction/uid-1/email',
      headers: { cookie },
      payload: { crumb, email: 'not-an-email' }
    })

    expect(response.statusCode).toBe(200)
    const $errorSummary = container.getByRole('alert')
    expect($errorSummary).toContainElement(
      container.getByRole('heading', { name: 'There is a problem' })
    )
    expect(
      container.getByRole('link', {
        name: 'Enter an email address in the correct format, like name@example.com'
      })
    ).toHaveAttribute('href', '#email')
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

  it.each([
    ['email', '/interaction/uid-1/email', '/interaction/uid-1'],
    ['code', '/interaction/uid-1/code', '/interaction/uid-1/code'],
    ['phone', '/interaction/uid-1/phone', '/interaction/uid-1/phone']
  ])(
    'POST %s rejects a duplicated field instead of crashing',
    async (field, url, formUrl) => {
      const { crumb, cookie } = await getWithCrumb(formUrl)

      // a duplicated key makes hapi parse the field as an array; only a
      // crafted request does this, but it must not reach the handlers as
      // an unhandled type
      const res = await server.inject({
        method: 'POST',
        url,
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&${field}=one&${field}=two`
      })

      expect(res.statusCode).toBe(400)
    }
  )

  /**
   * The form-action directive of a page's Content-Security-Policy
   * @param {string} url
   */
  async function formActionFor(url) {
    const res = await server.inject({ method: 'GET', url })
    const csp = String(res.headers['content-security-policy'])
    return /form-action ([^;]*)/.exec(csp)?.[1]
  }

  it.each(['/interaction/uid-1/code', '/interaction/uid-1/phone'])(
    'lets %s submit on towards the client that sent the user here',
    async (url) => {
      // completing sign-in 303s through the provider to the client's
      // redirect_uri, and the submitting page's form-action governs the
      // whole redirect chain
      expect(await formActionFor(url)).toContain('http://localhost:3009')
    }
  )

  it.each(['/', '/interaction/uid-1'])(
    'keeps %s submitting only to this service',
    async (url) => {
      expect(await formActionFor(url)).toBe("'self'")
    }
  )

  it('GET code shows the email from the stored record', async () => {
    jest.mocked(identityApi.getOtpEmail).mockResolvedValue('shown@example.com')

    const { container, response } = await renderResponse(server, {
      method: 'GET',
      url: '/interaction/uid-1/code'
    })

    expect(response.statusCode).toBe(200)
    const $heading = container.getByRole('heading', {
      name: 'Check your email',
      level: 1
    })
    expect($heading).toBeInTheDocument()
    expect(
      container.getByText('We have sent an email to: shown@example.com')
    ).toBeInTheDocument()
    expect(
      container.getByRole('textbox', {
        name: 'Enter the 6 digit security code'
      })
    ).toBeInTheDocument()
  })

  it('GET code sends the user back to the email step when no code was requested', async () => {
    // reaching the code page first (typed URL, restored tab) leaves nothing
    // to address the email to, and any code entered could only ever fail
    jest.mocked(identityApi.getOtpEmail).mockResolvedValue(null)

    const res = await server.inject({
      method: 'GET',
      url: '/interaction/uid-1/code'
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/interaction/uid-1')
  })

  it('never fetches the email for a dead interaction (cookie gate first)', async () => {
    detailsSpy.mockRejectedValue(
      new errors.SessionNotFound('session not found')
    )

    const res = await server.inject({
      method: 'GET',
      url: '/interaction/uid-1/code'
    })

    expect(res.statusCode).toBe(410)
    expect(identityApi.getOtpEmail).not.toHaveBeenCalled()
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
      payload: { crumb, code: '123456' }
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
      payload: { crumb, code: '123456' }
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/interaction/uid-1/phone')
  })

  it('POST code re-renders with an error on an invalid code', async () => {
    jest.mocked(identityApi.verifyOtp).mockResolvedValue({ status: 'invalid' })
    const { crumb, cookie } = await getWithCrumb(
      '/interaction/uid-1/code?email=a%40b.com'
    )

    const { container, response } = await renderResponse(server, {
      method: 'POST',
      url: '/interaction/uid-1/code',
      headers: { cookie },
      payload: { crumb, code: '000000' }
    })

    expect(response.statusCode).toBe(200)
    expect(container.getByRole('alert')).toContainElement(
      container.getByRole('heading', { name: 'There is a problem' })
    )
    expect(
      container.getByRole('link', {
        name: 'The code you entered is not correct or has expired – enter it again or request a new code'
      })
    ).toHaveAttribute('href', '#code')
  })

  it.each([
    '1',
    '12',
    '123',
    '1234',
    '12345',
    '1234567',
    '12345678',
    'abc123',
    '*&^%$£'
  ])(
    'POST code re-renders with an error when code is not 6 digits (%s)',
    async (code) => {
      jest
        .mocked(identityApi.verifyOtp)
        .mockResolvedValue({ status: 'invalid-code-format' })
      const { crumb, cookie } = await getWithCrumb(
        '/interaction/uid-1/code?email=a%40b.com'
      )

      const { container, response } = await renderResponse(server, {
        method: 'POST',
        url: '/interaction/uid-1/code',
        headers: { cookie },
        payload: { crumb, code }
      })

      expect(response.statusCode).toBe(200)
      expect(container.getByRole('alert')).toContainElement(
        container.getByRole('heading', { name: 'There is a problem' })
      )
      expect(
        container.getByRole('link', {
          name: 'Enter the security code using only 6 digits'
        })
      ).toHaveAttribute('href', '#code')
    }
  )

  it('POST a code with leading zeros reaches the API unchanged', async () => {
    // the zeros are part of the code, so they must survive to the API
    jest.mocked(identityApi.verifyOtp).mockResolvedValue({ status: 'invalid' })
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1/code')

    await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/code',
      headers: { cookie },
      payload: { crumb, code: '000001' }
    })

    expect(identityApi.verifyOtp).toHaveBeenCalledWith({
      uid: 'uid-1',
      code: '000001'
    })
  })

  it('POST an invalid code reaches the API, which returns an invalid status', async () => {
    jest.mocked(identityApi.verifyOtp).mockResolvedValue({ status: 'invalid' })
    const { crumb, cookie } = await getWithCrumb(
      '/interaction/uid-1/code?email=a%40b.com'
    )

    for (const code of ['123456', 'abcdef', 'abc123']) {
      const { container, response } = await renderResponse(server, {
        method: 'POST',
        url: '/interaction/uid-1/code',
        headers: { cookie },
        payload: { crumb, code }
      })

      expect(response.statusCode).toBe(200)
      expect(identityApi.verifyOtp).toHaveBeenLastCalledWith({
        uid: 'uid-1',
        code
      })
      expect(
        container.getByRole('link', {
          name: 'The code you entered is not correct or has expired – enter it again or request a new code'
        })
      ).toHaveAttribute('href', '#code')
    }
  })

  it('POST an empty code re-renders the required error without calling the API', async () => {
    const { crumb, cookie } = await getWithCrumb(
      '/interaction/uid-1/code?email=a%40b.com'
    )

    const { container, response } = await renderResponse(server, {
      method: 'POST',
      url: '/interaction/uid-1/code',
      headers: { cookie },
      payload: { crumb, code: '' }
    })

    expect(response.statusCode).toBe(200)
    expect(
      container.getByRole('link', { name: 'Enter the 6 digit security code' })
    ).toHaveAttribute('href', '#code')
    expect(identityApi.verifyOtp).not.toHaveBeenCalled()
  })

  it('POST code sends the user back to the email step when no code was requested', async () => {
    jest.mocked(identityApi.verifyOtp).mockResolvedValue({ status: 'invalid' })
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1/code')
    jest.mocked(identityApi.getOtpEmail).mockResolvedValue(null)

    const res = await server.inject({
      method: 'POST',
      url: '/interaction/uid-1/code',
      headers: { cookie },
      payload: { crumb, code: '123456' }
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/interaction/uid-1')
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

    const { container, response } = await renderResponse(server, {
      method: 'POST',
      url: '/interaction/uid-1/phone',
      headers: { cookie },
      payload: { crumb, phone: 'not a number' }
    })

    expect(response.statusCode).toBe(200)
    expect(container.getByRole('alert')).toContainElement(
      container.getByRole('heading', { name: 'There is a problem' })
    )
    expect(identityApi.completeSignup).not.toHaveBeenCalled()
  })

  it('POST phone re-renders with an error on an invalid phone', async () => {
    jest
      .mocked(identityApi.completeSignup)
      .mockResolvedValue({ status: 'invalid-phone' })
    const { crumb, cookie } = await getWithCrumb('/interaction/uid-1/phone')

    const { container, response } = await renderResponse(server, {
      method: 'POST',
      url: '/interaction/uid-1/phone',
      headers: { cookie },
      payload: { crumb, phone: '020 7946 0000' }
    })

    expect(response.statusCode).toBe(200)
    expect(
      container.getByRole('link', {
        name: 'Enter a mobile phone number in the correct format'
      })
    ).toHaveAttribute('href', '#phone')
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

describe('interaction route gating policy', () => {
  it('refuses to start when an interaction route is missing the gate', () => {
    const rogue = /** @type {never} */ ({
      table: () => [
        {
          method: 'get',
          path: '/interaction/{uid}/rogue',
          settings: { pre: [] }
        }
      ]
    })

    expect(() => {
      assertInteractionRoutesGated(rogue)
    }).toThrow(/missing the interaction gate/)
  })

  it('refuses to start when it no longer recognises any interaction route', () => {
    // a renamed journey or a prefixed mount would otherwise leave the guard
    // matching nothing and reporting success while protecting nothing
    const renamed = /** @type {never} */ ({
      table: () => [
        {
          method: 'get',
          path: '/sign-in/{uid}',
          settings: { pre: [] }
        }
      ]
    })

    expect(() => {
      assertInteractionRoutesGated(renamed)
    }).toThrow(/no interaction routes/i)
  })

  // the accepting side needs no test of its own: every suite that calls
  // createServer + initialize (including this one) runs the guard for real
})

/**
 * @import { Server } from '@hapi/hapi'
 * @import { ServerResponse } from 'node:http'
 */
