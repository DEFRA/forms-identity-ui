import { createServer } from '~/src/server/index.js'

/**
 * Build a minimal fetch Response stand-in with full control over headers
 * @param {number} status
 * @param {[string, string][]} [headerPairs]
 * @param {string} [body]
 */
function upstream(status, headerPairs = [], body = '') {
  const headers = new Headers()
  for (const [key, value] of headerPairs) {
    headers.append(key, value)
  }
  return /** @type {Response} */ (
    /** @type {unknown} */ ({
      ok: status >= 200 && status < 300,
      status,
      headers,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer)
    })
  )
}

describe('interaction routes', () => {
  /** @type {Server} */
  let server

  beforeAll(async () => {
    server = await createServer()
    await server.initialize()
  })

  afterAll(async () => {
    await server.stop()
  })

  /**
   * GET the email page to obtain a crumb cookie + matching token, the same
   * dance a real browser (and scripts/smoke.mjs) performs
   */
  async function getCrumb() {
    const res = await server.inject({
      method: 'GET',
      url: '/ui/interaction/test-uid'
    })
    const setCookies = /** @type {string[]} */ ([]).concat(
      res.headers['set-cookie'] ?? []
    )
    const crumbCookie = setCookies.find((c) => c.startsWith('crumb='))
    const crumb = crumbCookie?.split(';')[0].slice('crumb='.length) ?? ''
    return { crumb, cookie: `crumb=${crumb}`, page: res.payload }
  }

  describe('GET /ui/interaction/{uid} (email page)', () => {
    test('renders the email page with a crumb-protected form', async () => {
      const { crumb, page } = await getCrumb()

      expect(page).toContain('Sign in to save your progress')
      expect(page).toContain('action="/ui/interaction/test-uid/email"')
      expect(page).toContain('autocomplete="email"')
      expect(page).toContain('spellcheck="false"')
      expect(page).toContain(`name="crumb" value="${crumb}"`)
      expect(page).not.toContain('There is a problem')
    })
  })

  describe('POST /ui/interaction/{uid}/email', () => {
    test('rejects a missing crumb with 403 and never contacts the API', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch')

      const res = await server.inject({
        method: 'POST',
        url: '/ui/interaction/test-uid/email',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=a%40b.com'
      })

      expect(res.statusCode).toBe(403)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    test('re-renders with "Enter an email address" when the email is empty', async () => {
      const { crumb, cookie } = await getCrumb()

      const res = await server.inject({
        method: 'POST',
        url: '/ui/interaction/test-uid/email',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&email=`
      })

      expect(res.statusCode).toBe(400)
      expect(res.payload).toContain('There is a problem')
      expect(res.payload).toContain('Enter an email address')
      expect(res.payload).toContain('<title>Error: ')
      expect(res.payload).toContain('href="#email"')
    })

    test('re-renders with the format error when the email is invalid', async () => {
      const { crumb, cookie } = await getCrumb()

      const res = await server.inject({
        method: 'POST',
        url: '/ui/interaction/test-uid/email',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&email=not-an-email`
      })

      expect(res.statusCode).toBe(400)
      expect(res.payload).toContain(
        'Enter an email address in the correct format, like name@example.com'
      )
      expect(res.payload).toContain('value="not-an-email"')
    })

    test('requests a code server-to-server and renders the verify page', async () => {
      const { crumb, cookie } = await getCrumb()
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(upstream(200, [], '{}'))

      const res = await server.inject({
        method: 'POST',
        url: '/ui/interaction/test-uid/email',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&email=a%40b.com`
      })

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain('Enter the code we sent to a@b.com')
      expect(res.payload).toContain('action="/interaction/test-uid/complete"')
      expect(res.payload).toContain('name="email" value="a@b.com"')
      expect(res.payload).toContain(`name="crumb" value="${crumb}"`)
      expect(res.payload).toContain('autocomplete="one-time-code"')
      expect(res.payload).toContain('inputmode="numeric"')
      expect(res.payload).toContain('It expires in 15 minutes.')

      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe('http://localhost:4001/otp/request')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(/** @type {string} */ (init?.body))).toEqual({
        uid: 'test-uid',
        email: 'a@b.com'
      })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    })

    test('re-renders the email page with an error summary when /otp/request fails', async () => {
      const { crumb, cookie } = await getCrumb()
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(upstream(502))

      const res = await server.inject({
        method: 'POST',
        url: '/ui/interaction/test-uid/email',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&email=a%40b.com`
      })

      expect(res.statusCode).toBe(502)
      expect(res.payload).toContain(
        'Sorry, there was a problem sending your code. Try again.'
      )
      expect(res.payload).toContain('value="a@b.com"')
    })

    test('re-renders the email page with an error summary when /otp/request times out', async () => {
      const { crumb, cookie } = await getCrumb()
      const abortError = new Error('This operation was aborted')
      abortError.name = 'AbortError'
      jest.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)

      const res = await server.inject({
        method: 'POST',
        url: '/ui/interaction/test-uid/email',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&email=a%40b.com`
      })

      expect(res.statusCode).toBe(502)
      expect(res.payload).toContain(
        'Sorry, there was a problem sending your code. Try again.'
      )
    })
  })

  describe('GET /ui/interaction/{uid}/verify (try-again return leg)', () => {
    test('renders the code page with uid + email and no error on a fresh view', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/ui/interaction/test-uid/verify?email=a%40b.com'
      })

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain('Enter the code we sent to a@b.com')
      expect(res.payload).toContain('action="/interaction/test-uid/complete"')
      expect(res.payload).not.toContain('There is a problem')
    })

    test('shows the invalid code error when the backend redirected back with error=1', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/ui/interaction/test-uid/verify?email=a%40b.com&error=1'
      })

      expect(res.statusCode).toBe(200)
      expect(res.payload).toContain('There is a problem')
      expect(res.payload).toContain(
        'The security code you entered is not correct'
      )
      expect(res.payload).toContain('<title>Error: ')
      expect(res.payload).toContain('href="#code"')
    })
  })

  describe('POST /interaction/{uid}/complete (crumb-validated forwarding)', () => {
    test('rejects a missing crumb with 403 and never forwards to the API', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch')

      const res = await server.inject({
        method: 'POST',
        url: '/interaction/test-uid/complete',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=a%40b.com&code=123456'
      })

      expect(res.statusCode).toBe(403)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    test('rejects a mismatched crumb with 403', async () => {
      const { cookie } = await getCrumb()
      const fetchSpy = jest.spyOn(globalThis, 'fetch')

      const res = await server.inject({
        method: 'POST',
        url: '/interaction/test-uid/complete',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: 'crumb=wrong&email=a%40b.com&code=123456'
      })

      expect(res.statusCode).toBe(403)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    test('forwards the re-encoded form through the proxy and relays the resume redirect', async () => {
      const { crumb, cookie } = await getCrumb()
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        upstream(302, [
          ['location', 'http://localhost:3002/auth/test-uid'],
          ['set-cookie', '_session=xyz; path=/; httponly']
        ])
      )

      const res = await server.inject({
        method: 'POST',
        url: '/interaction/test-uid/complete',
        headers: {
          cookie: `${cookie}; _interaction=abc`,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&email=a%40b.com&code=123456`
      })

      // The provider's resume redirect + set-cookies flow back untouched
      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe('http://localhost:3002/auth/test-uid')
      expect(
        /** @type {string[]} */ ([]).concat(res.headers['set-cookie'] ?? [])
      ).toEqual(['_session=xyz; path=/; httponly'])

      const [url, init] = fetchSpy.mock.calls[0]
      expect(url).toBe('http://localhost:4001/interaction/test-uid/complete')
      expect(init?.method).toBe('POST')
      // Crumb was consumed by @hapi/crumb; only email + code are forwarded
      expect(init?.body).toBe('email=a%40b.com&code=123456')
      expect(init?.redirect).toBe('manual')

      const headers = /** @type {Record<string, string>} */ (init?.headers)
      expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
      expect(headers['content-length']).toBeUndefined()
      // The browser's cookies (interaction context) are preserved
      expect(headers.cookie).toContain('_interaction=abc')
      expect(headers['x-forwarded-proto']).toBe('http')
      expect(headers['x-forwarded-host']).toBe('localhost:3002')
    })

    test('relays the failure redirect back to the verify page untouched', async () => {
      const { crumb, cookie } = await getCrumb()
      const failureLocation =
        'http://localhost:3002/ui/interaction/test-uid/verify?email=a%40b.com&error=1'
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(upstream(302, [['location', failureLocation]]))

      const res = await server.inject({
        method: 'POST',
        url: '/interaction/test-uid/complete',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&email=a%40b.com&code=000000`
      })

      expect(res.statusCode).toBe(302)
      expect(res.headers.location).toBe(failureLocation)
    })

    test('returns a raw 504 when the identity API is unreachable', async () => {
      const { crumb, cookie } = await getCrumb()
      jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new TypeError('fetch failed'))

      const res = await server.inject({
        method: 'POST',
        url: '/interaction/test-uid/complete',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded'
        },
        payload: `crumb=${crumb}&email=a%40b.com&code=123456`
      })

      expect(res.statusCode).toBe(504)
      expect(res.payload).toBe('Gateway Timeout')
    })
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
