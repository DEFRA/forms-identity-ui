/**
 * Tests sign-out through RP-Initiated Logout, with a stub forms-identity-api
 * on loopback (see test/helpers/round-trip.js). The provider's confirm step
 * does the sign-out. This service only shows the page before that step.
 * These tests make sure that the page and the provider work together. They
 * show the page as a browser does and send the form as a browser does. Then
 * they check that the provider session ended.
 */
import { renderResponse } from '~/test/helpers/component-helpers.js'
import { REDIRECT_URI, useRoundTrip } from '~/test/helpers/round-trip.js'

const mockStsSend = jest.fn()

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: jest.fn()
  })),
  GetWebIdentityTokenCommand: jest.fn((input) => ({ input }))
}))

const POST_LOGOUT_REDIRECT_URI = new URL('/auth/signed-out', REDIRECT_URI).href

describe('logout round trip', () => {
  const roundTrip = useRoundTrip(mockStsSend)

  /**
   * Signs a citizen in and returns the tokens. The request names no
   * resource, so the access token is opaque. Only an opaque token can get
   * access to the userinfo endpoint.
   * @param {string} email
   */
  async function signIn(email) {
    const redeemed = await roundTrip.signInAndRedeem(email)
    expect(redeemed.statusCode).toBe(200)

    return /** @type {{ access_token: string, id_token: string }} */ (
      JSON.parse(redeemed.payload)
    )
  }

  /**
   * Opens the sign-out page and shows it as a browser does
   * @param {Record<string, string>} params
   */
  async function openSignOut(params) {
    const url = `/session/end?${new URLSearchParams(params).toString()}`
    const cookies = roundTrip.cookieHeader(url)
    const rendered = await renderResponse(roundTrip.server, {
      method: 'GET',
      url,
      headers: { ...(cookies && { cookie: cookies }) }
    })
    roundTrip.keepCookies(rendered.response)

    return rendered
  }

  /**
   * Sends the sign-out form with the fields that a browser sends when the
   * user presses Sign out
   * @param {Document} document
   */
  function submitSignOut(document) {
    const form = /** @type {HTMLFormElement} */ (
      document.getElementById('op.logoutForm')
    )
    const fields = Object.fromEntries(
      [...form.elements].map((element) => {
        const input = /** @type {HTMLInputElement} */ (element)
        return [input.name, input.value]
      })
    )

    return roundTrip.browse(new URL(form.action).pathname, fields)
  }

  /**
   * Calls the userinfo endpoint. The endpoint refuses a token after its
   * session ends.
   * @param {string} accessToken
   */
  function callProtectedResource(accessToken) {
    return roundTrip.server.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${accessToken}` }
    })
  }

  it('signs a citizen out when the runner sends their own ID token', async () => {
    const tokens = await signIn('own-hint@example.com')

    const { container, document, response } = await openSignOut({
      client_id: 'runner',
      id_token_hint: tokens.id_token,
      post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI,
      state: 'logout-state'
    })

    expect(response.statusCode).toBe(200)
    expect(
      container.getByRole('heading', {
        name: 'Are you sure you want to sign out?',
        level: 1
      })
    ).toBeInTheDocument()
    expect(
      container.getByText(
        'If you sign out, you’ll need to sign in again using your email address and security code.'
      )
    ).toBeInTheDocument()
    expect(
      container.getByRole('button', { name: 'Sign out' })
    ).toBeInTheDocument()

    // Cancel goes back to the client's post-logout redirect URI. The marker
    // tells the client to keep the user signed in.
    expect(container.getByRole('link', { name: 'Cancel' })).toHaveAttribute(
      'href',
      `${POST_LOGOUT_REDIRECT_URI}?state=logout-state&cancelled=true`
    )

    // With JavaScript, the page presses its own button.
    expect(
      document.querySelector('[data-module="app-auto-submit"] button')
    ).not.toBeNull()

    const signedOut = await submitSignOut(document)
    expect(signedOut.statusCode).toBe(303)
    expect(signedOut.headers.location).toBe(
      `${POST_LOGOUT_REDIRECT_URI}?state=logout-state`
    )

    // The full provider session ended, not only the runner's part.
    expect(roundTrip.jar.has('_session')).toBe(false)
    expect((await callProtectedResource(tokens.access_token)).statusCode).toBe(
      401
    )
  })

  it('asks the citizen to confirm when the request carries no ID token', async () => {
    const tokens = await signIn('no-hint@example.com')

    const { container, document } = await openSignOut({ client_id: 'runner' })

    expect(
      container.getByRole('heading', {
        name: 'Are you sure you want to sign out?',
        level: 1
      })
    ).toBeInTheDocument()
    expect(document.querySelector('[data-module="app-auto-submit"]')).toBeNull()

    // Without a post-logout redirect URI, the page shows no Cancel link.
    expect(
      container.queryByRole('link', { name: 'Cancel' })
    ).not.toBeInTheDocument()

    // The citizen stays signed in until they press the button.
    expect((await callProtectedResource(tokens.access_token)).statusCode).toBe(
      200
    )

    await submitSignOut(document)
    expect(roundTrip.jar.has('_session')).toBe(false)
    expect((await callProtectedResource(tokens.access_token)).statusCode).toBe(
      401
    )
  })
})
