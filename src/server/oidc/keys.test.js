import {
  cookieKeys,
  readNumberedKeys,
  signingJwks
} from '~/src/server/oidc/keys.js'

const JWKS_KEYS = {
  prefix: 'OIDC_JWKS_KEY_',
  pointerName: 'OIDC_JWKS_SIGNING_KEY'
}

/**
 * @param {string} kid
 */
function jwk(kid) {
  return JSON.stringify({ kty: 'RSA', kid, d: `private-part-of-${kid}` })
}

describe('readNumberedKeys', () => {
  it('returns the signing key first, then the others from the highest number to the lowest', () => {
    const env = {
      OIDC_JWKS_KEY_1: 'one',
      OIDC_JWKS_KEY_2: 'two',
      OIDC_JWKS_KEY_3: 'three',
      OIDC_JWKS_KEY_10: 'ten'
    }

    const keys = readNumberedKeys(env, { ...JWKS_KEYS, signingNumber: 2 })

    expect(keys).toEqual([
      { number: 2, name: 'OIDC_JWKS_KEY_2', value: 'two' },
      { number: 10, name: 'OIDC_JWKS_KEY_10', value: 'ten' },
      { number: 3, name: 'OIDC_JWKS_KEY_3', value: 'three' },
      { number: 1, name: 'OIDC_JWKS_KEY_1', value: 'one' }
    ])
  })

  it('reads only names that are the prefix and a number', () => {
    const env = {
      OIDC_JWKS_KEY_1: 'one',
      OIDC_JWKS_KEY_: 'no number',
      OIDC_JWKS_KEY_01: 'leading zero',
      OIDC_JWKS_KEY_0: 'zero',
      OIDC_JWKS_KEY_1A: 'letter',
      OIDC_COOKIE_KEY_2: 'other set',
      MY_OIDC_JWKS_KEY_3: 'longer name'
    }

    const keys = readNumberedKeys(env, { ...JWKS_KEYS, signingNumber: 1 })

    expect(keys.map((key) => key.name)).toEqual(['OIDC_JWKS_KEY_1'])
  })

  it('treats an empty value as a key that is not there', () => {
    const env = {
      OIDC_JWKS_KEY_1: 'one',
      OIDC_JWKS_KEY_2: '',
      OIDC_JWKS_KEY_3: '   ',
      OIDC_JWKS_KEY_4: undefined
    }

    const keys = readNumberedKeys(env, { ...JWKS_KEYS, signingNumber: 1 })

    expect(keys.map((key) => key.number)).toEqual([1])
  })

  it('refuses a pointer to a key that is not there, and lists the keys that are', () => {
    const env = {
      OIDC_JWKS_KEY_1: 'one',
      OIDC_JWKS_KEY_2: 'two',
      OIDC_JWKS_KEY_3: 'three'
    }

    expect(() =>
      readNumberedKeys(env, { ...JWKS_KEYS, signingNumber: 100 })
    ).toThrow(
      'OIDC_JWKS_SIGNING_KEY is 100, but the keys that exist are 1, 2, 3'
    )
  })

  it('refuses to load when there are no keys', () => {
    expect(() =>
      readNumberedKeys({}, { ...JWKS_KEYS, signingNumber: 1 })
    ).toThrow('OIDC_JWKS_SIGNING_KEY is 1, but no OIDC_JWKS_KEY_<n> is set')
  })
})

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
})

describe('cookieKeys', () => {
  it('returns each key with its number, signing key first', () => {
    const env = {
      OIDC_COOKIE_KEY_1: 'cookie-one',
      OIDC_COOKIE_KEY_2: 'cookie-two',
      OIDC_COOKIE_KEY_3: 'cookie-three'
    }

    expect(cookieKeys(env, 2)).toEqual([
      { number: 2, value: 'cookie-two' },
      { number: 3, value: 'cookie-three' },
      { number: 1, value: 'cookie-one' }
    ])
  })

  it('refuses a pointer to a key that is not there', () => {
    expect(() => cookieKeys({ OIDC_COOKIE_KEY_1: 'cookie-one' }, 7)).toThrow(
      'OIDC_COOKIE_SIGNING_KEY is 7, but the keys that exist are 1'
    )
  })
})
