import { config } from '~/src/config/index.js'
import { getJson } from '~/src/server/common/helpers/fetch.js'
import { buildProviderConfig } from '~/src/server/oidc/provider-config.js'

jest.mock('~/src/server/common/helpers/fetch.js')

const fakeAdapter = /** @type {import('oidc-provider').AdapterConstructor} */ (
  /** @type {unknown} */ (jest.fn())
)

const fakeCtx = /** @type {never} */ (null)

describe('buildProviderConfig', () => {
  it('registers runner as a confidential client with PKCE required', () => {
    const cfg = buildProviderConfig(config, fakeAdapter)

    expect(cfg.clients).toEqual([
      {
        client_id: 'runner',
        client_secret: process.env.OIDC_CLIENT_SECRET,
        redirect_uris: [
          'http://localhost:3009/callback',
          'http://localhost:3000/callback'
        ],
        response_types: ['code'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_basic'
      }
    ])
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
      email: ['email', 'email_verified']
    })
  })

  it('findAccount resolves claims from the API and undefined on 404', async () => {
    const cfg = buildProviderConfig(config, fakeAdapter)
    jest
      .mocked(getJson)
      .mockResolvedValue(
        /** @type {never} */ ({ body: { id: 'acc-1', email: 'a@b.com' } })
      )

    const account = await cfg.findAccount?.(fakeCtx, 'acc-1', undefined)
    expect(account?.accountId).toBe('acc-1')
    await expect(
      account?.claims('userinfo', 'openid email', {}, [])
    ).resolves.toEqual({
      sub: 'acc-1',
      email: 'a@b.com',
      email_verified: true
    })

    const notFound = Object.assign(new Error('Not Found'), {
      isBoom: true,
      output: { statusCode: 404 }
    })
    jest.mocked(getJson).mockRejectedValue(notFound)
    await expect(
      cfg.findAccount?.(fakeCtx, 'gone', undefined)
    ).resolves.toBeUndefined()
  })

  it.each([
    ['oidc.jwks', /OIDC_JWKS/],
    ['oidc.cookieKeys', /OIDC_COOKIE_KEYS/],
    ['oidc.clientSecret', /OIDC_CLIENT_SECRET/]
  ])('fails loud when %s is missing', (key, message) => {
    const realGet = config.get.bind(config)
    const spy = jest.spyOn(config, 'get').mockImplementation(
      /** @type {never} */ (
        (/** @type {string} */ k) => {
          if (k === key) {
            return ''
          }
          return realGet(/** @type {never} */ (k))
        }
      )
    )

    expect(() => buildProviderConfig(config, fakeAdapter)).toThrow(message)
    spy.mockRestore()
  })
})
