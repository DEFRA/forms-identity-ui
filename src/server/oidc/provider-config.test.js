import { getAccount } from '~/src/server/lib/identity-api.js'
import { buildProviderConfig } from '~/src/server/oidc/provider-config.js'

jest.mock('~/src/server/lib/identity-api.js', () => ({
  getAccount: jest.fn()
}))

const fakeAdapter = /** @type {import('oidc-provider').AdapterConstructor} */ (
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
        response_types: ['code'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'private_key_jwt',
        id_token_signed_response_alg: 'ES256',
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
      Interaction: 3600,
      Session: 86400,
      Grant: 86400
    })
    expect(cfg.claims).toEqual({
      openid: ['sub'],
      email: ['email']
    })
  })

  it('findAccount resolves claims from the API and undefined on 404', async () => {
    const cfg = buildProviderConfig(fakeAdapter)
    jest.mocked(getAccount).mockResolvedValue({
      id: 'acc-1',
      email: 'a@b.com'
    })

    const account = await cfg.findAccount?.(fakeCtx, 'acc-1', undefined)
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
