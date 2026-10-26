/**
 * Key rotation against a stub forms-identity-api on loopback (see
 * test/helpers/round-trip.js).
 *
 * Each scenario sets the keys, then redeploys the service, as an operator
 * does. The stub keeps the sessions and grants across each deploy, so a
 * token from one deploy is used in the next.
 */
import { createLocalJWKSet, jwtVerify } from 'jose'

import { generateSigningJwk } from '~/scripts/jwks.cjs'
import {
  CLIENT_ASSERTION_TYPE,
  ISSUER,
  clientAssertion,
  useRoundTrip
} from '~/test/helpers/round-trip.js'

// Each deploy registers the request logger again. The ECS format writes in
// this thread, rather than in a new transport worker for each deploy, so
// that the workers do not add up.
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
 * @param {Record<number, string>} keys - the value of each key, by number
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
 * @param {Record<number, JWK>} keys - the JWK of each key, by number
 * @returns {Record<number, string>}
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
   * @param {Record<number, JWK>} keys
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

    return /** @type {{ keys: JWK[] }} */ (JSON.parse(res.payload))
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
    return [kidOf(tokens.id_token), kidOf(tokens.access_token)]
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

    return /** @type {Tokens & { refresh_token: string }} */ (
      JSON.parse(res.payload)
    )
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

  it('Add a new signing key', async () => {
    await deploy({ 1: oldKey }, 1)
    const { refresh_token: refreshToken } = await signIn('add-key@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 1)

    const { keys } = await publishedKeys()
    expect(keys.map((key) => key.kid)).toIncludeSameMembers([
      oldKey.kid,
      newKey.kid
    ])

    expect(signedBy(await refresh(refreshToken))).toEqual([
      oldKey.kid,
      oldKey.kid
    ])
  })

  it('Move the pointer to the new signing key', async () => {
    await deploy({ 1: oldKey, 2: newKey }, 1)
    const oldTokens = await signIn('move-pointer@example.com')

    await deploy({ 1: oldKey, 2: newKey }, 2)

    const newTokens = await refresh(oldTokens.refresh_token)
    expect(signedBy(newTokens)).toEqual([newKey.kid, newKey.kid])
    await expect(verifyBoth(newTokens)).resolves.toBeDefined()

    expect(signedBy(oldTokens)).toEqual([oldKey.kid, oldKey.kid])
    await expect(verifyBoth(oldTokens)).resolves.toBeDefined()
  })

  it('Move the pointer back to the old signing key', async () => {
    await deploy({ 1: oldKey, 2: newKey }, 2)
    const { refresh_token: refreshToken } = await signIn(
      'move-pointer-back@example.com'
    )

    await deploy({ 1: oldKey, 2: newKey }, 1)

    expect(signedBy(await refresh(refreshToken))).toEqual([
      oldKey.kid,
      oldKey.kid
    ])
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

/**
 * @typedef {{ id_token: string, access_token: string }} Tokens
 */

/**
 * @import { JWK } from 'jose'
 */
