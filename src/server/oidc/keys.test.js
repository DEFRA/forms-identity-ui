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
      OIDC_JWKS_KEY_4: jwk('kid-4'),
      OIDC_JWKS_KEY_5: jwk('kid-5')
    }

    expect(signingJwks(env, 5)).toEqual([
      { kty: 'RSA', kid: 'kid-5', d: 'private-part-of-kid-5' },
      { kty: 'RSA', kid: 'kid-4', d: 'private-part-of-kid-4' }
    ])
  })

  it('logs the number and the kid of each key, and which key signs', () => {
    const info = jest.spyOn(logger, 'info')
    const env = {
      OIDC_JWKS_KEY_4: jwk('kid-4'),
      OIDC_JWKS_KEY_5: jwk('kid-5')
    }

    signingJwks(env, 5)

    expect(info).toHaveBeenCalledWith(
      '[oidcKeys] Signing keys loaded - OIDC_JWKS_KEY_5 signs - 5: kid-5, 4: kid-4'
    )
  })

  it.each([
    ['is not JSON', '{"kty":"RSA","kid":"cut-off-secret'],
    ['is not an object', '"only-a-secret-text"'],
    ['has no kid', '{"kty":"RSA","d":"secret"}']
  ])(
    'refuses a key that %s, and names the setting without its value',
    (_case, value) => {
      const env = { OIDC_JWKS_KEY_1: jwk('kid-1'), OIDC_JWKS_KEY_2: value }

      /** @type {unknown} */
      let thrown
      try {
        signingJwks(env, 1)
      } catch (err) {
        thrown = err
      }

      expect(thrown).toEqual(
        new Error('OIDC_JWKS_KEY_2 must be one JWK, as JSON, with a kid')
      )
      expect(String(thrown)).not.toContain('secret')
    }
  )

  it('refuses two keys with the same kid, and names the two settings', () => {
    const env = {
      OIDC_JWKS_KEY_1: jwk('same-kid'),
      OIDC_JWKS_KEY_2: jwk('same-kid')
    }

    expect(() => signingJwks(env, 2)).toThrow(
      'OIDC_JWKS_KEY_1 and OIDC_JWKS_KEY_2 have the same kid'
    )
  })

  it('refuses a pointer to a key that is not there', () => {
    expect(() => signingJwks({ OIDC_JWKS_KEY_1: jwk('kid-1') }, 7)).toThrow(
      'OIDC_JWKS_SIGNING_KEY is 7, but the keys that exist are 1'
    )
  })
})

describe('cookieKeys', () => {
  it('returns the signing key first, then the others from the lowest number to the highest', () => {
    const env = {
      OIDC_COOKIE_KEY_10: 'cookie-ten',
      OIDC_COOKIE_KEY_3: 'cookie-three',
      OIDC_COOKIE_KEY_1: 'cookie-one',
      OIDC_COOKIE_KEY_2: 'cookie-two'
    }

    expect(cookieKeys(env, 3)).toEqual([
      'cookie-three',
      'cookie-one',
      'cookie-two',
      'cookie-ten'
    ])
  })

  it('logs the number of each key, and which key signs', () => {
    const info = jest.spyOn(logger, 'info')
    const env = {
      OIDC_COOKIE_KEY_1: 'cookie-one',
      OIDC_COOKIE_KEY_2: 'cookie-two'
    }

    cookieKeys(env, 2)

    expect(info).toHaveBeenCalledWith(
      '[oidcKeys] Cookie keys loaded - OIDC_COOKIE_KEY_2 signs - 2, 1'
    )
  })

  it('reads only names that are the prefix and a number', () => {
    const env = {
      OIDC_COOKIE_KEY_1: 'one',
      OIDC_COOKIE_KEY_: 'no number',
      OIDC_COOKIE_KEY_01: 'leading zero',
      OIDC_COOKIE_KEY_0: 'zero',
      OIDC_COOKIE_KEY_1A: 'letter',
      OIDC_JWKS_KEY_2: 'other set',
      MY_OIDC_COOKIE_KEY_3: 'longer name'
    }

    expect(cookieKeys(env, 1)).toEqual(['one'])
  })

  it('treats an empty value as a key that is not there', () => {
    const env = {
      OIDC_COOKIE_KEY_1: 'one',
      OIDC_COOKIE_KEY_2: '',
      OIDC_COOKIE_KEY_3: '   ',
      OIDC_COOKIE_KEY_4: undefined
    }

    expect(cookieKeys(env, 1)).toEqual(['one'])
  })

  it('refuses a pointer to a key that is not there, and lists the keys that are', () => {
    const env = {
      OIDC_COOKIE_KEY_1: 'one',
      OIDC_COOKIE_KEY_2: 'two',
      OIDC_COOKIE_KEY_3: 'three'
    }

    expect(() => cookieKeys(env, 100)).toThrow(
      'OIDC_COOKIE_SIGNING_KEY is 100, but the keys that exist are 1, 2, 3'
    )
  })

  it('refuses to load when there are no keys', () => {
    expect(() => cookieKeys({}, 1)).toThrow(
      'OIDC_COOKIE_SIGNING_KEY is 1, but no OIDC_COOKIE_KEY_<n> is set'
    )
  })
})
