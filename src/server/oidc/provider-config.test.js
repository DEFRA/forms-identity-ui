import {
  createLogContext,
  getUserId,
  runWithLogContext
} from '@defra/forms-common'

import { getAccount } from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import {
  buildProviderConfig,
  extraTokenClaims
} from '~/src/server/oidc/provider-config.js'

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
          'http://localhost:3000/callback',
          'https://forms-runner.dev-env.cloud/auth/callback'
        ],
        post_logout_redirect_uris: [
          'http://localhost:3009/auth/signed-out',
          'http://localhost:3000/'
        ],
        initiate_login_uri: 'http://localhost:3009/auth/initiate',
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'private_key_jwt',
        id_token_signed_response_alg: 'RS256',
        backchannel_logout_uri: 'http://localhost:3009/auth/backchannel-logout',
        backchannel_logout_session_required: true,
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
      RefreshToken: 604800,
      Interaction: 3600,
      Session: 86400,
      Grant: 604800
    })
    expect(cfg.claims).toEqual({
      openid: ['sub'],
      email: ['email']
    })
  })

  describe('refresh tokens', () => {
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

  describe('extraTokenClaims', () => {
    const submissionApi = 'urn:defra:forms:forms-submission-api'

    /**
     * A context with the account the provider loaded for the token request
     * @param {{ accountId: string, email?: string } | undefined} account
     */
    function contextWith(account) {
      return /** @type {never} */ ({
        oidc: {
          account: account && {
            accountId: account.accountId,
            claims: () =>
              Promise.resolve({ sub: account.accountId, email: account.email })
          }
        }
      })
    }

    /**
     * @param {Record<string, unknown>} [overrides]
     */
    function accessToken(overrides = {}) {
      return /** @type {never} */ ({
        kind: 'AccessToken',
        aud: submissionApi,
        accountId: 'acc-1',
        ...overrides
      })
    }

    describe('OIDC_EMAIL_CLAIM_RESOURCE_SERVERS', () => {
      const original = process.env.OIDC_EMAIL_CLAIM_RESOURCE_SERVERS

      afterEach(() => {
        process.env.OIDC_EMAIL_CLAIM_RESOURCE_SERVERS = original
        jest.resetModules()
      })

      it('refuses to load when it names an API that is not a resource server', async () => {
        process.env.OIDC_EMAIL_CLAIM_RESOURCE_SERVERS =
          'urn:defra:forms:somewhere-else'
        jest.resetModules()

        await expect(
          import('~/src/server/oidc/provider-config.js')
        ).rejects.toThrow(
          'OIDC_EMAIL_CLAIM_RESOURCE_SERVERS names urn:defra:forms:somewhere-else, which is not in OIDC_RESOURCE_SERVERS'
        )
      })

      it('adds no email to any access token when it is empty', async () => {
        process.env.OIDC_EMAIL_CLAIM_RESOURCE_SERVERS = ''
        jest.resetModules()

        const fresh = await import('~/src/server/oidc/provider-config.js')
        const ctx = contextWith({ accountId: 'acc-1', email: 'a@b.com' })

        await expect(
          fresh.extraTokenClaims(ctx, accessToken())
        ).resolves.toBeUndefined()
      })
    })

    it('is the claims hook of the provider', () => {
      const cfg = buildProviderConfig(fakeAdapter)

      expect(cfg.extraTokenClaims).toBe(extraTokenClaims)
    })

    it('adds the email of the account to an access token for an API that needs it', async () => {
      const ctx = contextWith({ accountId: 'acc-1', email: 'a@b.com' })

      await expect(extraTokenClaims(ctx, accessToken())).resolves.toEqual({
        email: 'a@b.com'
      })
      expect(getAccount).not.toHaveBeenCalled()
    })

    it('adds no email to an access token for another API', async () => {
      const ctx = contextWith({ accountId: 'acc-1', email: 'a@b.com' })

      await expect(
        extraTokenClaims(
          ctx,
          accessToken({ aud: 'urn:defra:forms:another-api' })
        )
      ).resolves.toBeUndefined()
    })

    it('adds no email to a token that is not an access token', async () => {
      const ctx = contextWith({ accountId: 'acc-1', email: 'a@b.com' })

      await expect(
        extraTokenClaims(ctx, accessToken({ kind: 'ClientCredentials' }))
      ).resolves.toBeUndefined()
    })

    it.each([
      ['no account is loaded', undefined],
      [
        'the loaded account is another account',
        { accountId: 'acc-2', email: 'c@d.com' }
      ],
      ['the account has no email', { accountId: 'acc-1' }],
      ['the account has an empty email', { accountId: 'acc-1', email: '' }]
    ])('adds no email when %s', async (_name, account) => {
      await expect(
        extraTokenClaims(contextWith(account), accessToken())
      ).resolves.toBeUndefined()
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

  it('findAccount adds the account ID to the log context', async () => {
    const cfg = buildProviderConfig(fakeAdapter)
    jest.mocked(getServiceToken).mockResolvedValue('token-1')
    jest.mocked(getAccount).mockResolvedValue(null)

    const userId = await runWithLogContext(createLogContext(), async () => {
      await cfg.findAccount?.(fakeCtx, 'acc-1', undefined)

      return getUserId()
    })

    expect(userId).toBe('acc-1')
  })
})

/**
 * @import { AdapterConstructor } from 'oidc-provider'
 */
