/**
 * Whole sign-in journey against a stub forms-identity-api on loopback (see
 * test/helpers/round-trip.js).
 *
 * Two things are proved here that unit tests cannot. First, that the digest
 * is applied consistently: a mismatch between what one call site writes and
 * what another reads reads as absent, so the journey simply stops rather than
 * raising anything. Second, the acceptance criterion for this change — no
 * request path the stub saw carries a value the browser holds as a cookie or
 * the relying party receives in its callback.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { SignJWT, generateKeyPair } from 'jose'

import {
  CLIENT_ASSERTION_TYPE,
  ISSUER,
  KNOWN_CODE,
  PHONE,
  REDIRECT_URI,
  clientAssertion,
  useRoundTrip
} from '~/test/helpers/round-trip.js'

// The journey retrieves a caller token for every request the adapter and
// sign-in service make, so STS is stubbed here too — this test checks what
// the API traffic contains and what it must not leak, not STS connectivity,
// which service-token.test.js already covers.
const mockStsSend = jest.fn()

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: jest.fn()
  })),
  GetWebIdentityTokenCommand: jest.fn((input) => ({ input }))
}))

const RESOURCE = 'urn:defra:forms:forms-submission-api'
const EMAIL = 'someone@example.com'

describe('sign-in round trip', () => {
  const {
    accounts,
    browse,
    crumb,
    follow,
    jar,
    seenAuthorizations,
    seenPaths,
    signInAndRedeem,
    tokenRequest
  } = useRoundTrip(mockStsSend)
  /** @type {(id: string) => string} */
  let hashId

  beforeAll(async () => {
    // The helper sets the config to the stub first, so import this here.
    ;({ hashId } = await import('~/src/server/common/helpers/hash-id.js'))
  })

  it('signs a user in end to end and leaks nothing into a request path', async () => {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const authorize = `/auth?${new URLSearchParams({
      client_id: 'runner',
      response_type: 'code',
      scope: 'openid email',
      redirect_uri: REDIRECT_URI,
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()}`

    // the provider parks the request and sends the browser to the email page
    const start = await browse(authorize)
    expect(start.statusCode).toBe(303)

    const interaction = String(start.headers.location)
    const uid = interaction.split('/')[2]
    const response = await browse(interaction)
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe(`${interaction}/email`)

    const emailed = await browse(`${interaction}/email`, {
      ...crumb(),
      email: EMAIL
    })
    expect(emailed.headers.location).toBe(`${interaction}/code`)
    expect((await browse(`${interaction}/code`)).statusCode).toBe(200)

    // no account yet, so a correct code moves on to the phone step
    const coded = await browse(`${interaction}/code`, {
      ...crumb(),
      code: KNOWN_CODE
    })
    expect(coded.headers.location).toBe(`${interaction}/phone`)
    expect((await browse(`${interaction}/phone`)).statusCode).toBe(200)

    // completing the phone step finishes the interaction; the provider then
    // resumes, auto-grants consent and issues the code
    const finished = await follow(
      await browse(`${interaction}/phone`, { ...crumb(), phone: PHONE })
    )

    const callback = new URL(String(finished.headers.location))
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI)
    expect(callback.searchParams.get('state')).toBe('state-1')

    const authorizationCode = /** @type {string} */ (
      callback.searchParams.get('code')
    )
    expect(authorizationCode).toBeTruthy()
    expect(accounts.size).toBe(1)

    // The acceptance criterion: nothing the browser or the relying party
    // holds is recoverable from a path the API's proxies and logs recorded.
    // The interaction uid is here too — it is in the UI's own URLs, which is
    // a documented residual, but it must not reach the API in plaintext.
    const secrets = [
      ...[...jar.values()].map((cookie) => decodeURIComponent(cookie.value)),
      authorizationCode,
      uid
    ].filter((secret) => secret.length > 8)

    expect(secrets.length).toBeGreaterThan(2)
    for (const secret of secrets) {
      expect(seenPaths.join('\n')).not.toContain(secret)
    }

    // and the digest is what took its place — the journey only reaches here
    // if every key matched, because a digest on one side and a plaintext
    // value on the other reads as absent rather than as a failure
    const sessionCookie = /** @type {string} */ (jar.get('_session')?.value)
    expect(sessionCookie).toBeTruthy()
    expect(seenPaths.some((path) => path.includes(hashId(sessionCookie)))).toBe(
      true
    )
    expect(
      seenPaths.some((path) => path.includes(hashId(authorizationCode)))
    ).toBe(true)

    // The caller token passes through the real server, adapter and Wreck:
    // every request the stub saw carried it, so nothing along that path
    // drops or changes the header.
    expect(seenAuthorizations.length).toBeGreaterThan(0)
    for (const authorization of seenAuthorizations) {
      expect(authorization).toBe('Bearer stub-service-token')
    }
  })

  /**
   * @param {string} token
   * @param {number} index - 0 for the header, 1 for the payload
   */
  function decodeSegment(token, index) {
    return JSON.parse(
      Buffer.from(token.split('.')[index], 'base64url').toString()
    )
  }

  /**
   * The body of a refresh request, with a new client assertion
   * @param {string} refreshToken
   */
  async function refreshParams(refreshToken) {
    return {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(),
      resource: RESOURCE
    }
  }

  it.each([
    [
      'at the authorization and token endpoints',
      'token-journey-both@example.com',
      { resource: RESOURCE }
    ],
    [
      'at the authorization endpoint only',
      'token-journey-authorization@example.com',
      {}
    ]
  ])(
    'issues a JWT access token for the API the client named %s',
    async (_where, email, tokenParams) => {
      const redeemed = await signInAndRedeem(email, {
        state: 'state-2',
        resource: RESOURCE,
        tokenParams
      })

      expect(redeemed.statusCode).toBe(200)

      const body = JSON.parse(redeemed.payload)
      const accessToken = String(body.access_token)

      // an opaque token is one segment, so this tells the two apart
      expect(accessToken.split('.')).toHaveLength(3)

      const signedIn = [...accounts.values()].find(
        (account) => account.email === email
      )
      expect(signedIn).toBeDefined()

      expect(decodeSegment(accessToken, 0)).toMatchObject({ alg: 'RS256' })
      expect(decodeSegment(accessToken, 1)).toMatchObject({
        iss: ISSUER,
        aud: RESOURCE,
        client_id: 'runner',
        sub: signedIn?.id
      })

      // A resource-bound token cannot reach userinfo, so the claims move to
      // the ID token and the client reads the email there
      expect(decodeSegment(String(body.id_token), 1)).toMatchObject({ email })

      // short-lived, with a refresh token to renew it
      expect(body.expires_in).toBe(300)
      expect(typeof body.refresh_token).toBe('string')
    }
  )

  it('rotates the refresh token, and revokes the grant when a used one is sent again', async () => {
    const email = 'refresh-journey@example.com'
    const redeemed = await signInAndRedeem(email, {
      state: 'state-3',
      resource: RESOURCE,
      tokenParams: { resource: RESOURCE }
    })
    expect(redeemed.statusCode).toBe(200)

    const first = JSON.parse(redeemed.payload)
    const originalRefreshToken = String(first.refresh_token)

    const refreshed = await tokenRequest(
      await refreshParams(originalRefreshToken)
    )
    expect(refreshed.statusCode).toBe(200)

    const second = JSON.parse(refreshed.payload)
    const accessToken = String(second.access_token)

    // a new JWT for the same API and citizen
    expect(accessToken).not.toBe(first.access_token)
    expect(accessToken.split('.')).toHaveLength(3)
    expect(decodeSegment(accessToken, 1)).toMatchObject({
      aud: RESOURCE,
      sub: decodeSegment(String(first.access_token), 1).sub
    })
    expect(second.expires_in).toBe(300)

    // a new refresh token, and a new ID token
    expect(typeof second.refresh_token).toBe('string')
    expect(second.refresh_token).not.toBe(originalRefreshToken)
    // (the ID token can be byte-identical to the first when both are issued
    // in the same second, so only its subject is compared)
    expect(typeof second.id_token).toBe('string')
    expect(decodeSegment(String(second.id_token), 1)).toMatchObject({
      sub: decodeSegment(String(first.id_token), 1).sub
    })

    // Using the replaced token again looks like a stolen token, so the
    // provider refuses it and revokes the grant
    const reused = await tokenRequest(await refreshParams(originalRefreshToken))
    expect(reused.statusCode).toBe(400)
    expect(JSON.parse(reused.payload)).toMatchObject({ error: 'invalid_grant' })

    // which also ends the refresh token issued in its place
    const afterRevocation = await tokenRequest(
      await refreshParams(String(second.refresh_token))
    )
    expect(afterRevocation.statusCode).toBe(400)
    expect(JSON.parse(afterRevocation.payload)).toMatchObject({
      error: 'invalid_grant'
    })
  })

  it('refuses a refresh without a valid client assertion', async () => {
    const redeemed = await signInAndRedeem('refresh-client-auth@example.com', {
      state: 'state-4',
      resource: RESOURCE,
      tokenParams: { resource: RESOURCE }
    })
    expect(redeemed.statusCode).toBe(200)

    const refreshToken = String(JSON.parse(redeemed.payload).refresh_token)

    // no assertion at all
    const unauthenticated = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      resource: RESOURCE
    })
    expect(unauthenticated.statusCode).toBe(401)
    expect(JSON.parse(unauthenticated.payload)).toMatchObject({
      error: 'invalid_client'
    })

    // an assertion signed with a key the provider does not hold for runner,
    // even under the registered key id
    const [registered] = JSON.parse(
      String(process.env.OIDC_RUNNER_PRIVATE_JWKS)
    ).keys
    const { privateKey } = await generateKeyPair('RS256')
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: registered.kid })
      .setIssuer('runner')
      .setSubject('runner')
      .setAudience(ISSUER)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(privateKey)

    const wrongKey = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: forged,
      resource: RESOURCE
    })
    expect(wrongKey.statusCode).toBe(401)
    expect(JSON.parse(wrongKey.payload)).toMatchObject({
      error: 'invalid_client'
    })

    // neither attempt used up the token: the real client can still refresh
    const genuine = await tokenRequest(await refreshParams(refreshToken))
    expect(genuine.statusCode).toBe(200)
  })
})
