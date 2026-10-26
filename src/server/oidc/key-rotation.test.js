/**
 * Key rotation against a stub forms-identity-api on loopback (see
 * test/helpers/round-trip.js).
 *
 * Each scenario sets the keys, then redeploys the service, as an operator
 * does. The stub keeps the sessions and grants across each deploy, so a
 * token or a cookie from one deploy is used in the next.
 */
import { createHash, randomBytes } from 'node:crypto'

import { createLocalJWKSet, jwtVerify } from 'jose'

import { generateSigningJwk } from '~/scripts/jwks.cjs'
import {
  CLIENT_ASSERTION_TYPE,
  ISSUER,
  REDIRECT_URI,
  clientAssertion,
  useRoundTrip
} from '~/test/helpers/round-trip.js'

// ECS logs in this thread, so the redeploys start no log transport workers
process.env.LOG_FORMAT = 'ecs'

const mockStsSend = jest.fn()

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: mockStsSend,
    destroy: jest.fn()
  })),
  GetWebIdentityTokenCommand: jest.fn((input) => ({ input }))
}))

const RESOURCE = 'urn:defra:forms:forms-submission-api'

/**
 * Sets one set of numbered keys and its pointer, and removes the keys of
 * that set that are not given
 * @param {string} prefix
 * @param {string} pointerName
 * @param {SecretValuesByNumber} keys - the value of each key, by number
 * @param {number} signingKey - the number that the pointer holds
 */
function setKeys(prefix, pointerName, keys, signingKey) {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(prefix)) {
      Reflect.deleteProperty(process.env, name)
    }
  }

  for (const [number, value] of Object.entries(keys)) {
    process.env[`${prefix}${number}`] = value
  }

  process.env[pointerName] = String(signingKey)
}

/**
 * Writes each JWK as JSON, as an operator pastes it into a secret
 * @param {JwksByNumber} keys - the JWK of each key, by number
 * @returns {SecretValuesByNumber}
 */
function asSecretValues(keys) {
  return Object.fromEntries(
    Object.entries(keys).map(([number, jwk]) => [number, JSON.stringify(jwk)])
  )
}

/**
 * @param {string} token
 */
function kidOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())
    .kid
}

describe('signing key rotation', () => {
  const roundTrip = useRoundTrip(mockStsSend)
  const { redeploy, signInAndRedeem, tokenRequest } = roundTrip

  const oldKey = generateSigningJwk()
  const newKey = generateSigningJwk()

  /**
   * Start the service with a new set of signing keys
   * @param {JwksByNumber} keys
   * @param {number} signingKey
   */
  async function deploy(keys, signingKey) {
    setKeys(
      'OIDC_JWKS_KEY_',
      'OIDC_JWKS_SIGNING_KEY',
      asSecretValues(keys),
      signingKey
    )
    await redeploy()
  }

  /**
   * The keys at the JWKS endpoint, as a relying party reads them
   */
  async function publishedKeys() {
    // The server changes with each deploy
    const res = await roundTrip.server.inject({ method: 'GET', url: '/jwks' })

    return /** @type {JSONWebKeySet} */ (JSON.parse(res.payload))
  }

  /**
   * Verifies a token against the JWKS endpoint, as a relying party does.
   * The ID token is for the client, and the access token is for the API.
   * @param {string} token
   * @param {string} audience
   */
  async function verify(token, audience) {
    return jwtVerify(token, createLocalJWKSet(await publishedKeys()), {
      issuer: ISSUER,
      audience
    })
  }

  /**
   * Verifies the ID token and the access token
   * @param {Tokens} tokens
   */
  function verifyBoth(tokens) {
    return Promise.all([
      verify(tokens.id_token, 'runner'),
      verify(tokens.access_token, RESOURCE)
    ])
  }

  /**
   * The kid of the key that signed each token
   * @param {Tokens} tokens
   */
  function signedBy(tokens) {
    return {
      idToken: kidOf(tokens.id_token),
      accessToken: kidOf(tokens.access_token)
    }
  }

  /**
   * Signs a user in and returns the tokens
   * @param {string} email
   */
  async function signIn(email) {
    const res = await signInAndRedeem(email, {
      resource: RESOURCE,
      tokenParams: { resource: RESOURCE }
    })
    expect(res.statusCode).toBe(200)

    return /** @type {SignInTokens} */ (JSON.parse(res.payload))
  }

  /**
   * Gets new tokens with a refresh token, without a new sign in
   * @param {string} refreshToken
   */
  async function refresh(refreshToken) {
    const res = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(),
      resource: RESOURCE
    })
    expect(res.statusCode).toBe(200)

    return /** @type {Tokens} */ (JSON.parse(res.payload))
  }

  it("Adds a new signing key but doesn't use it without the pointer", async () => {
    await deploy({ 1: oldKey }, 1)
    const { refresh_token: refreshToken } = await signIn('add-key@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 1)

    const { keys } = await publishedKeys()
    expect(keys.map((key) => key.kid)).toIncludeSameMembers([
      oldKey.kid,
      newKey.kid
    ])

    expect(signedBy(await refresh(refreshToken))).toEqual({
      idToken: oldKey.kid,
      accessToken: oldKey.kid
    })
  })

  it('Move the pointer to the new signing key', async () => {
    await deploy({ 1: oldKey, 2: newKey }, 1)
    const oldTokens = await signIn('move-pointer@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 2)

    // Tokens with new keys can be verified
    const newTokens = await refresh(oldTokens.refresh_token)
    expect(signedBy(newTokens)).toEqual({
      idToken: newKey.kid,
      accessToken: newKey.kid
    })
    await expect(verifyBoth(newTokens)).resolves.toBeDefined()

    // Tokens with old keys can still be verified
    expect(signedBy(oldTokens)).toEqual({
      idToken: oldKey.kid,
      accessToken: oldKey.kid
    })
    await expect(verifyBoth(oldTokens)).resolves.toBeDefined()
  })

  it('Move the pointer back to the old signing key', async () => {
    await deploy({ 1: oldKey, 2: newKey }, 2)
    const { refresh_token: refreshToken } = await signIn(
      'move-pointer-back@example.com'
    )

    await deploy({ 1: oldKey, 2: newKey }, 1)

    expect(signedBy(await refresh(refreshToken))).toEqual({
      idToken: oldKey.kid,
      accessToken: oldKey.kid
    })
  })

  it('Delete the old signing key', async () => {
    // Tokens from before the pointer moved, which the old key signed
    await deploy({ 1: oldKey, 2: newKey }, 1)
    const oldTokens = await signIn('delete-key@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 2)
    await deploy({ 2: newKey }, 2)

    const { keys } = await publishedKeys()
    expect(keys.map((key) => key.kid)).toEqual([newKey.kid])

    await expect(verify(oldTokens.id_token, 'runner')).rejects.toMatchObject({
      code: 'ERR_JWKS_NO_MATCHING_KEY'
    })
    await expect(
      verify(oldTokens.access_token, RESOURCE)
    ).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' })
  })
})

describe('cookie key rotation', () => {
  const { browse, follow, jar, redeploy, signInAndRedeem } =
    useRoundTrip(mockStsSend)

  const oldKey = randomBytes(32).toString('hex')
  const newKey = randomBytes(32).toString('hex')

  /**
   * @param {Record<number, string>} keys
   * @param {number} signingKey
   */
  async function deploy(keys, signingKey) {
    setKeys('OIDC_COOKIE_KEY_', 'OIDC_COOKIE_SIGNING_KEY', keys, signingKey)
    await redeploy()
  }

  /**
   * Signs a user in and returns a copy of their cookies, so that the test can
   * hold more than one browser
   * @param {string} email
   */
  async function signIn(email) {
    expect((await signInAndRedeem(email)).statusCode).toBe(200)

    return new Map(jar)
  }

  /**
   * Opens a browser with the cookies of a user
   * @param {Map<string, { value: string, path: string }>} cookies
   */
  function useBrowser(cookies) {
    jar.clear()

    for (const [name, cookie] of cookies) {
      jar.set(name, cookie)
    }
  }

  /**
   * Asks the provider for a sign in with no page. The provider answers with
   * a code when the user is signed in, and with `login_required` when the
   * user is not.
   */
  async function silentSignIn() {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    const res = await follow(
      await browse(
        `/auth?${new URLSearchParams({
          client_id: 'runner',
          response_type: 'code',
          scope: 'openid email',
          prompt: 'none',
          redirect_uri: REDIRECT_URI,
          state: 'state',
          nonce: 'nonce',
          code_challenge: challenge,
          code_challenge_method: 'S256'
        }).toString()}`
      )
    )

    return new URL(String(res.headers.location)).searchParams
  }

  /**
   * @param {URLSearchParams} answer
   */
  function signedIn(answer) {
    return answer.has('code')
  }

  it('Add a new cookie key', async () => {
    await deploy({ 1: oldKey }, 1)
    const user = await signIn('add-cookie-key@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 1)

    useBrowser(user)
    expect(signedIn(await silentSignIn())).toBe(true)

    // A cookie that the current key signed needs no new signature
    const signature = jar.get('_session.sig')?.value
    expect(signature).toBe(user.get('_session.sig')?.value)
  })

  it('Move the pointer to the new cookie key', async () => {
    await deploy({ 1: oldKey, 2: newKey }, 1)
    const user = await signIn('move-cookie-pointer@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 2)

    useBrowser(user)
    expect(signedIn(await silentSignIn())).toBe(true)

    // The new key signs the cookie again, so the cookie works with the new
    // key only
    expect(jar.get('_session.sig')?.value).not.toBe(
      user.get('_session.sig')?.value
    )
    const resigned = new Map(jar)

    await deploy({ 2: newKey }, 2)

    useBrowser(resigned)
    expect(signedIn(await silentSignIn())).toBe(true)
  })

  it('Move the pointer back to the old cookie key', async () => {
    await deploy({ 1: oldKey, 2: newKey }, 2)
    const user = await signIn('move-cookie-pointer-back@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 1)

    useBrowser(user)
    expect(signedIn(await silentSignIn())).toBe(true)

    // The old key signs the cookie again, so the cookie works with the old
    // key only
    expect(jar.get('_session.sig')?.value).not.toBe(
      user.get('_session.sig')?.value
    )
    const resigned = new Map(jar)

    await deploy({ 1: oldKey }, 1)

    useBrowser(resigned)
    expect(signedIn(await silentSignIn())).toBe(true)
  })

  it('Delete the old cookie key', async () => {
    await deploy({ 1: oldKey, 2: newKey }, 1)
    const visitor = await signIn('cookie-visitor@example.com')
    const absentee = await signIn('cookie-absentee@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 2)

    useBrowser(visitor)
    expect(signedIn(await silentSignIn())).toBe(true)
    const visited = new Map(jar)

    await deploy({ 2: newKey }, 2)

    useBrowser(visited)
    expect(signedIn(await silentSignIn())).toBe(true)

    useBrowser(absentee)
    const answer = await silentSignIn()
    expect(answer.get('error')).toBe('login_required')
  })
})

/**
 * @typedef {{ id_token: string, access_token: string }} Tokens
 */

/**
 * @typedef {Tokens & { refresh_token: string }} SignInTokens
 */

/**
 * @typedef {Record<number, JWK>} JwksByNumber
 */

/**
 * @typedef {Record<number, string>} SecretValuesByNumber
 */

/**
 * @import { JSONWebKeySet, JWK } from 'jose'
 */
