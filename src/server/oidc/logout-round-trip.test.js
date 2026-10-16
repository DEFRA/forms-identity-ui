/**
 * Tests sign-out through RP-Initiated Logout, with a stub forms-identity-api
 * on loopback (see test/helpers/round-trip.js). The provider's confirm step
 * does the sign-out. This service only shows the page before that step.
 * These tests make sure that the page and the provider work together. They
 * show the page as a browser does and send the form as a browser does. Then
 * they check that the provider session ended.
 *
 * The runner asks for `offline_access`, and sign-out keeps that grant. When
 * the provider sends the citizen back, the runner revokes its refresh token
 * at the revocation endpoint (RFC 7009). The tests do the same, and then
 * check that no token of the sign-in still works.
 */
import { getUserId } from '@defra/forms-common'

import { renderResponse } from '~/test/helpers/component-helpers.js'
import {
  CLIENT_ASSERTION_TYPE,
  REDIRECT_URI,
  clientAssertion,
  useRoundTrip
} from '~/test/helpers/round-trip.js'

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

    return /** @type {{ access_token: string, id_token: string, refresh_token: string }} */ (
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
    return submitForm(
      /** @type {HTMLFormElement} */ (document.getElementById('op.logoutForm'))
    )
  }

  /**
   * Sends a form with the fields that a browser sends
   * @param {HTMLFormElement} form
   */
  function submitForm(form) {
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

  /**
   * Uses the refresh token as the runner does
   * @param {string} refreshToken
   */
  async function refresh(refreshToken) {
    return roundTrip.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion()
    })
  }

  /**
   * Revokes the refresh token as the runner does when the citizen comes back
   * from a completed sign-out
   * @param {string} refreshToken
   */
  async function revoke(refreshToken) {
    const revoked = await roundTrip.revocationRequest(refreshToken, {
      token_type_hint: 'refresh_token'
    })
    expect(revoked.statusCode).toBe(200)
  }

  /**
   * Checks that no token of the sign-in still works
   * @param {{ access_token: string, refresh_token: string }} tokens
   */
  async function expectSignInEnded(tokens) {
    expect((await callProtectedResource(tokens.access_token)).statusCode).toBe(
      401
    )

    const refreshed = await refresh(tokens.refresh_token)
    expect(refreshed.statusCode).toBe(400)
    expect(JSON.parse(refreshed.payload)).toMatchObject({
      error: 'invalid_grant'
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

    // The provider keeps the `offline_access` grant, so the runner's tokens
    // work until the runner revokes them
    expect((await refresh(tokens.refresh_token)).statusCode).toBe(200)

    await revoke(tokens.refresh_token)
    await expectSignInEnded(tokens)
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

    // Without a state from the client, Cancel only carries the marker.
    const withRedirect = await openSignOut({
      client_id: 'runner',
      post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI
    })
    expect(
      withRedirect.container.getByRole('link', { name: 'Cancel' })
    ).toHaveAttribute('href', `${POST_LOGOUT_REDIRECT_URI}?cancelled=true`)

    await submitSignOut(withRedirect.document)
    expect(roundTrip.jar.has('_session')).toBe(false)

    await revoke(tokens.refresh_token)
    await expectSignInEnded(tokens)
  })

  it('adds the account ID of the provider session to the log context', async () => {
    const tokens = await signIn('log-context@example.com')
    const { sub } = /** @type {{ sub: string }} */ (
      JSON.parse(
        Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString()
      )
    )

    // The response log is written when this event is emitted
    const onResponse = jest.fn(() => getUserId())
    roundTrip.server.events.once('response', onResponse)

    await openSignOut({ client_id: 'runner' })

    expect(onResponse).toHaveReturnedWith(sub)
  })

  it('ends the sign-in when the provider session expired before sign-out', async () => {
    const tokens = await signIn('expired-session@example.com')

    // The provider session lasts a day, and the refresh token lasts longer.
    // Sign-out after the session has expired finds no grant to end, so the
    // runner's revocation is the step that ends the sign-in.
    for (const key of roundTrip.artifacts.keys()) {
      if (key.startsWith('session/')) {
        roundTrip.artifacts.delete(key)
      }
    }

    const { container, document } = await openSignOut({
      client_id: 'runner',
      id_token_hint: tokens.id_token,
      post_logout_redirect_uri: POST_LOGOUT_REDIRECT_URI,
      state: 'logout-state'
    })

    // With no session, there is nobody to ask, so the provider skips the
    // sign-out page and its own page posts straight to the confirm step
    expect(
      container.queryByRole('heading', {
        name: 'Are you sure you want to sign out?'
      })
    ).not.toBeInTheDocument()

    const signedOut = await submitForm(
      /** @type {HTMLFormElement} */ (document.querySelector('form'))
    )
    expect(signedOut.statusCode).toBe(303)
    expect(signedOut.headers.location).toBe(
      `${POST_LOGOUT_REDIRECT_URI}?state=logout-state`
    )

    expect((await refresh(tokens.refresh_token)).statusCode).toBe(200)

    await revoke(tokens.refresh_token)
    await expectSignInEnded(tokens)
  })

  it('keeps the sign-in when a revocation carries no client assertion', async () => {
    const tokens = await signIn('unauthenticated-revoke@example.com')

    const refused = await roundTrip.server.inject({
      method: 'POST',
      url: '/token/revocation',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        client_id: 'runner',
        token: tokens.refresh_token,
        token_type_hint: 'refresh_token'
      }).toString()
    })

    expect(refused.statusCode).toBe(401)
    expect(JSON.parse(refused.payload)).toMatchObject({
      error: 'invalid_client'
    })
    expect((await refresh(tokens.refresh_token)).statusCode).toBe(200)
    expect((await callProtectedResource(tokens.access_token)).statusCode).toBe(
      200
    )
  })
})
