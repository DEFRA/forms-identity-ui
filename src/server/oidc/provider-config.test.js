import { getAccount } from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { buildProviderConfig } from '~/src/server/oidc/provider-config.js'

jest.mock('~/src/server/lib/identity-api.js', () => ({
  getAccount: jest.fn()
}))

jest.mock('~/src/server/lib/service-token.js', () => ({
  getServiceToken: jest.fn()
}))

const fakeAdapter = /** @type {AdapterConstructor} */ (
  /** @type {unknown} */ (jest.fn())
)

const fakeCtx = /** @type {never} */ (null)

describe('buildProviderConfig', () => {
  it('registers runner as a confidential client proving itself with a signed assertion', () => {
    const cfg = buildProviderConfig(fakeAdapter)

    // The runner holds a private key and signs an assertion; this service
    // only ever holds the public half, so there is no shared secret to leak
    expect(cfg.clients).toEqual([
      {
        client_id: 'runner',
        redirect_uris: [
          'http://localhost:3009/callback',
          'http://localhost:3000/callback'
        ],
        post_logout_redirect_uris: [
          'http://localhost:3009/auth/signed-out',
          'http://localhost:3000/'
        ],
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'private_key_jwt',
        id_token_signed_response_alg: 'RS256',
        jwks: JSON.parse(String(process.env.OIDC_RUNNER_JWKS))
      }
    ])
    expect(cfg.clientAuthMethods).toEqual(['private_key_jwt'])
    expect(cfg.pkce?.required?.(fakeCtx, /** @type {never} */ (null))).toBe(
      true
    )
    expect(
      cfg.interactions?.url?.(fakeCtx, /** @type {never} */ ({ uid: 'u-1' }))
    ).toBe('/interaction/u-1')
    expect(cfg.ttl).toEqual({
      AuthorizationCode: 60,
      IdToken: 300,
      AccessToken: 300,
      RefreshToken: 86400,
      Interaction: 3600,
      Session: 86400,
      Grant: 86400
    })
    expect(cfg.claims).toEqual({
      openid: ['sub'],
      email: ['email']
    })
  })

  describe('refresh tokens', () => {
    it('issues a refresh token to a client allowed the grant, without offline_access', async () => {
      const cfg = buildProviderConfig(fakeAdapter)
      const client = /** @type {Client} */ (
        /** @type {unknown} */ ({
          grantTypeAllowed: (/** @type {string} */ grantType) =>
            cfg.clients?.[0].grant_types?.includes(grantType)
        })
      )

      expect(
        await cfg.issueRefreshToken?.(
          fakeCtx,
          client,
          /** @type {never} */ (null)
        )
      ).toBe(true)
    })

    it('does not issue a refresh token to a client not allowed the grant', async () => {
      const cfg = buildProviderConfig(fakeAdapter)
      const client = /** @type {Client} */ (
        /** @type {unknown} */ ({ grantTypeAllowed: () => false })
      )

      expect(
        await cfg.issueRefreshToken?.(
          fakeCtx,
          client,
          /** @type {never} */ (null)
        )
      ).toBe(false)
    })

    it('keeps the same refresh token on every refresh', () => {
      const cfg = buildProviderConfig(fakeAdapter)

      expect(cfg.rotateRefreshToken).toBe(false)
    })
  })

  it('signs tokens and verifies client assertions with RS256', () => {
    const cfg = buildProviderConfig(fakeAdapter)

    expect(cfg.enabledJWA).toEqual({
      idTokenSigningAlgValues: ['RS256'],
      clientAuthSigningAlgValues: ['RS256']
    })
  })

  describe('resource indicators', () => {
    it.each([
      'urn:defra:forms:forms-submission-api',
      'urn:defra:forms:another-api'
    ])(
      'issues a JWT access token for %s, the audience being the name asked for',
      (resourceIndicator) => {
        const cfg = buildProviderConfig(fakeAdapter)
        const { resourceIndicators } = cfg.features ?? {}

        expect(resourceIndicators?.enabled).toBe(true)

        const info = resourceIndicators?.getResourceServerInfo?.(
          fakeCtx,
          resourceIndicator,
          /** @type {never} */ (null)
        )

        expect(info).toEqual({
          scope: '',
          audience: resourceIndicator,
          accessTokenFormat: 'jwt',
          accessTokenTTL: 300,
          jwt: { sign: { alg: 'RS256' } }
        })
      }
    )

    it('refuses a resource it does not serve, so no token is minted for another audience', () => {
      const cfg = buildProviderConfig(fakeAdapter)
      const { resourceIndicators } = cfg.features ?? {}

      expect(() =>
        resourceIndicators?.getResourceServerInfo?.(
          fakeCtx,
          'urn:defra:forms:somewhere-else',
          /** @type {never} */ (null)
        )
      ).toThrow('invalid_target')
    })
  })

  it('findAccount resolves claims from the API and undefined on 404', async () => {
    const cfg = buildProviderConfig(fakeAdapter)
    jest.mocked(getServiceToken).mockResolvedValue('token-1')
    jest.mocked(getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com'
    })

    const account = await cfg.findAccount?.(fakeCtx, 'acc-1', undefined)
    expect(getAccount).toHaveBeenCalledWith('acc-1', 'token-1')
    expect(account?.accountId).toBe('acc-1')
    await expect(
      account?.claims('userinfo', 'openid email', {}, [])
    ).resolves.toEqual({
      sub: 'acc-1',
      email: 'a@b.com'
    })

    jest.mocked(getAccount).mockResolvedValue(null)
    await expect(
      cfg.findAccount?.(fakeCtx, 'gone', undefined)
    ).resolves.toBeUndefined()
  })
})

/**
 * @import { AdapterConstructor, Client } from 'oidc-provider'
 */
