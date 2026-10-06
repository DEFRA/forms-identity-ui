import { cookieKeys, signingJwks } from '~/src/server/oidc/keys.js'

/**
 * @param {string} kid
 */
function jwk(kid) {
  return JSON.stringify({ kty: 'RSA', kid, d: `private-part-of-${kid}` })
}

describe('signingJwks', () => {
  it('returns each key with its number, signing key first', () => {
    const env = {
      OIDC_JWKS_KEY_4: jwk('kid-4'),
      OIDC_JWKS_KEY_5: jwk('kid-5')
    }

    const keys = signingJwks(env, 5)

    expect(keys.map(({ number, jwk: { kid } }) => ({ number, kid }))).toEqual([
      { number: 5, kid: 'kid-5' },
      { number: 4, kid: 'kid-4' }
    ])
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
      { number: 3, value: 'cookie-three' },
      { number: 1, value: 'cookie-one' },
      { number: 2, value: 'cookie-two' },
      { number: 10, value: 'cookie-ten' }
    ])
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

    expect(cookieKeys(env, 1)).toEqual([{ number: 1, value: 'one' }])
  })

  it('treats an empty value as a key that is not there', () => {
    const env = {
      OIDC_COOKIE_KEY_1: 'one',
      OIDC_COOKIE_KEY_2: '',
      OIDC_COOKIE_KEY_3: '   ',
      OIDC_COOKIE_KEY_4: undefined
    }

    expect(cookieKeys(env, 1)).toEqual([{ number: 1, value: 'one' }])
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
