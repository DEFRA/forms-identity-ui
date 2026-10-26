import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { cookieKeys, signingJwks } from '~/src/server/oidc/keys.js'

/**
 * @param {string} kid
 */
function jwk(kid) {
  return JSON.stringify({ kty: 'RSA', kid, d: `private-part-of-${kid}` })
}

describe('signingJwks', () => {
  it('returns the keys with the signing key first', () => {
    const env = {
      OIDC_JWKS_KEY_20260701: jwk('kid-old'),
      OIDC_JWKS_KEY_20261026: jwk('kid-new')
    }

    const keys = signingJwks(env, 20261026)

    expect(keys).toHaveLength(2)
    expect(keys.map((key) => key.kid)).toEqual(['kid-new', 'kid-old'])
  })

  it('logs how many keys are loaded, which key signs, and the kid of each key', () => {
    const info = jest.spyOn(logger, 'info')
    const env = {
      OIDC_JWKS_KEY_20260701: jwk('kid-old'),
      OIDC_JWKS_KEY_20261026: jwk('kid-new')
    }

    signingJwks(env, 20261026)

    expect(info.mock.calls).toEqual([
      ['[oidcKeys] 2 signing keys loaded'],
      ['[oidcKeys] Signing with OIDC_JWKS_KEY_20261026'],
      ['[oidcKeys] Loaded OIDC_JWKS_KEY_20261026: kid-new'],
      ['[oidcKeys] Loaded OIDC_JWKS_KEY_20260701: kid-old']
    ])
  })

  it('refuses a key that is not JSON, and names the setting', () => {
    const env = {
      OIDC_JWKS_KEY_20261001: jwk('kid-1'),
      OIDC_JWKS_KEY_20261026: '{"kty":"RSA","kid":"cut-off'
    }

    expect(() => signingJwks(env, 20261001)).toThrow(
      "Couldn't parse JWK as JSON in OIDC_JWKS_KEY_20261026"
    )
  })

  it('refuses a key with no kid, and names the setting', () => {
    const env = {
      OIDC_JWKS_KEY_20261001: jwk('kid-1'),
      OIDC_JWKS_KEY_20261026: '{"kty":"RSA","d":"private-part"}'
    }

    expect(() => signingJwks(env, 20261001)).toThrow(
      'JWK in OIDC_JWKS_KEY_20261026 must be an object with a kid'
    )
  })

  it('refuses two keys with the same kid, and names the two settings', () => {
    const env = {
      OIDC_JWKS_KEY_20261001: jwk('same-kid'),
      OIDC_JWKS_KEY_20261026: jwk('same-kid')
    }

    expect(() => signingJwks(env, 20261026)).toThrow(
      'OIDC_JWKS_KEY_20261001 and OIDC_JWKS_KEY_20261026 have the same kid'
    )
  })

  it('returns the other keys from the oldest date to the newest', () => {
    const env = {
      OIDC_JWKS_KEY_20270101: jwk('kid-2027'),
      OIDC_JWKS_KEY_20260701: jwk('kid-july'),
      OIDC_JWKS_KEY_20260101: jwk('kid-january'),
      OIDC_JWKS_KEY_20260401: jwk('kid-april')
    }

    expect(signingJwks(env, 20260701).map((key) => key.kid)).toEqual([
      'kid-july',
      'kid-january',
      'kid-april',
      'kid-2027'
    ])
  })

  it('reads only names that are the prefix and digits', () => {
    const env = {
      OIDC_JWKS_KEY_20261026: jwk('dated'),
      OIDC_JWKS_KEY_: jwk('no-date'),
      'OIDC_JWKS_KEY_2026-10-26': jwk('dashes'),
      OIDC_JWKS_KEY_20261026A: jwk('letter'),
      MY_OIDC_JWKS_KEY_20261026: jwk('longer-name')
    }

    expect(signingJwks(env, 20261026).map((key) => key.kid)).toEqual(['dated'])
  })

  it.each([
    ['too few digits', 'OIDC_JWKS_KEY_2026126'],
    ['too many digits', 'OIDC_JWKS_KEY_202610260'],
    ['a month that does not exist', 'OIDC_JWKS_KEY_20261326'],
    ['a day that does not exist', 'OIDC_JWKS_KEY_20260230']
  ])('refuses a name with %s, and names the setting', (_case, name) => {
    const env = {
      OIDC_JWKS_KEY_20261026: jwk('dated'),
      [name]: jwk('bad-date')
    }

    expect(() => signingJwks(env, 20261026)).toThrow(
      `${name} must end with a date as YYYYMMDD`
    )
  })

  it('refuses an empty key, and names the setting', () => {
    const env = {
      OIDC_JWKS_KEY_20261001: jwk('one'),
      OIDC_JWKS_KEY_20261026: '   '
    }

    expect(() => signingJwks(env, 20261001)).toThrow(
      'OIDC_JWKS_KEY_20261026 is empty'
    )
  })

  it('refuses a pointer to a key that is not there', () => {
    const env = { OIDC_JWKS_KEY_20261001: jwk('kid-1') }

    expect(() => signingJwks(env, 20991231)).toThrow(
      'No key found with signing date 20991231'
    )
  })
})

describe('cookieKeys', () => {
  it('returns the signing key first, then the others from the oldest date to the newest', () => {
    const env = {
      OIDC_COOKIE_KEY_20270101: 'cookie-2027',
      OIDC_COOKIE_KEY_20260701: 'cookie-july',
      OIDC_COOKIE_KEY_20260101: 'cookie-january',
      OIDC_COOKIE_KEY_20260401: 'cookie-april'
    }

    expect(cookieKeys(env, 20260701)).toEqual([
      'cookie-july',
      'cookie-january',
      'cookie-april',
      'cookie-2027'
    ])
  })

  it('logs how many keys are loaded, which key signs, and each key', () => {
    const info = jest.spyOn(logger, 'info')
    const env = {
      OIDC_COOKIE_KEY_20261001: 'cookie-one',
      OIDC_COOKIE_KEY_20261026: 'cookie-two'
    }

    cookieKeys(env, 20261026)

    expect(info.mock.calls).toEqual([
      ['[oidcKeys] 2 cookie keys loaded'],
      ['[oidcKeys] Signing with OIDC_COOKIE_KEY_20261026'],
      ['[oidcKeys] Loaded OIDC_COOKIE_KEY_20261026'],
      ['[oidcKeys] Loaded OIDC_COOKIE_KEY_20261001']
    ])
  })

  it('reads only the cookie keys', () => {
    const env = {
      OIDC_COOKIE_KEY_20261001: 'cookie-one',
      OIDC_JWKS_KEY_20261026: jwk('kid-2')
    }

    expect(cookieKeys(env, 20261001)).toEqual(['cookie-one'])
  })

  it('refuses a pointer to a key that is not there', () => {
    expect(() =>
      cookieKeys({ OIDC_COOKIE_KEY_20261001: 'cookie-one' }, 20261026)
    ).toThrow('No key found with signing date 20261026')
  })
})
