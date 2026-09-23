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
      RefreshToken: expect.any(Function),
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

    it('rotates the refresh token on every refresh', () => {
      const cfg = buildProviderConfig(fakeAdapter)

      expect(cfg.rotateRefreshToken).toBe(true)
    })

    it('gives a new refresh token the configured lifetime', () => {
      const ttl = refreshTokenTtl()

      expect(ttl(/** @type {never} */ ({ oidc: { entities: {} } }))).toBe(86400)
      // a token read outside a request has no context
      expect(ttl(/** @type {never} */ (undefined))).toBe(86400)
    })

    it('gives a rotated refresh token only the time left on the one it replaces', () => {
      const ttl = refreshTokenTtl()
      const ctx = /** @type {never} */ ({
        oidc: { entities: { RotatedRefreshToken: { remainingTTL: 1234 } } }
      })

      expect(ttl(ctx)).toBe(1234)
    })

    /**
     * The refresh token lifetime function from the configuration
     */
    function refreshTokenTtl() {
      const ttl = buildProviderConfig(fakeAdapter).ttl?.RefreshToken

      if (typeof ttl !== 'function') {
        throw new Error('ttl.RefreshToken is not a function')
      }

      return (/** @type {KoaContextWithOIDC} */ ctx) =>
        ttl(ctx, /** @type {never} */ (null), /** @type {never} */ (null))
    }
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

  describe('rpInitiatedLogout.logoutSource', () => {
    /**
     * @param {{ session?: object, sub?: string, params?: object }} options
     */
    function makeCtx({ session, sub, params = {} } = {}) {
      const emit = jest.fn()
      const cookiesSet = jest.fn()
      const redirect = jest.fn()
      const urlFor = jest.fn(() => 'https://issuer.example/session/end/success')

      const ctx = /** @type {KoaContextWithOIDC} */ (
        /** @type {unknown} */ ({
          status: undefined,
          cookies: { set: cookiesSet },
          redirect,
          oidc: {
            session,
            params,
            entities:
              sub === undefined ? {} : { IdTokenHint: { payload: { sub } } },
            provider: {
              cookieName: (/** @type {string} */ name) => `_${name}`,
              emit
            },
            urlFor
          }
        })
      )

      return { ctx, emit, cookiesSet, redirect, urlFor }
    }

    function getLogoutSource() {
      const source =
        buildProviderConfig(fakeAdapter).features?.rpInitiatedLogout
          ?.logoutSource

      if (typeof source !== 'function') {
        throw new Error('rpInitiatedLogout.logoutSource is not a function')
      }

      return source
    }

    it('refuses when there is no session to end', async () => {
      const { ctx } = makeCtx({ sub: 'acc-1' })

      await expect(getLogoutSource()(ctx, '')).rejects.toMatchObject({
        isBoom: true,
        output: { statusCode: 400 }
      })
    })

    it('refuses when the id_token_hint belongs to someone else', async () => {
      const destroy = jest.fn()
      const { ctx } = makeCtx({
        session: { accountId: 'acc-1', destroy },
        sub: 'acc-2'
      })

      await expect(getLogoutSource()(ctx, '')).rejects.toMatchObject({
        isBoom: true,
        output: { statusCode: 400 }
      })
      expect(destroy).not.toHaveBeenCalled()
    })

    it('ends the session and redirects to the post_logout_redirect_uri, forwarding state', async () => {
      const destroy = jest.fn()
      const { ctx, emit, cookiesSet, redirect } = makeCtx({
        session: { accountId: 'acc-1', destroy },
        sub: 'acc-1',
        params: {
          post_logout_redirect_uri: 'https://runner.example/signed-out',
          state: 'xyz'
        }
      })

      await getLogoutSource()(ctx, '')

      expect(destroy).toHaveBeenCalled()
      expect(cookiesSet).toHaveBeenCalledWith(
        '_session',
        null,
        expect.any(Object)
      )
      expect(ctx.status).toBe(303)
      expect(redirect).toHaveBeenCalledWith(
        'https://runner.example/signed-out?state=xyz'
      )
      expect(emit).toHaveBeenCalledWith('end_session.success', ctx)
    })

    it('falls back to the provider success page without a post_logout_redirect_uri', async () => {
      const destroy = jest.fn()
      const { ctx, redirect, urlFor } = makeCtx({
        session: { accountId: 'acc-1', destroy },
        sub: 'acc-1'
      })

      await getLogoutSource()(ctx, '')

      expect(urlFor).toHaveBeenCalledWith('end_session_success')
      expect(redirect).toHaveBeenCalledWith(
        'https://issuer.example/session/end/success'
      )
    })

    it('does not forward state without a post_logout_redirect_uri', async () => {
      const destroy = jest.fn()
      const { ctx, redirect } = makeCtx({
        session: { accountId: 'acc-1', destroy },
        sub: 'acc-1',
        params: { state: 'xyz' }
      })

      await getLogoutSource()(ctx, '')

      expect(redirect).toHaveBeenCalledWith(
        'https://issuer.example/session/end/success'
      )
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
 * @import { AdapterConstructor, Client, KoaContextWithOIDC } from 'oidc-provider'
 */
