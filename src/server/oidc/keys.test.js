import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { signingJwks } from '~/src/server/oidc/keys.js'

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

  it('logs how many keys are loaded, which key signs, and the kid of each key', () => {
    const info = jest.spyOn(logger, 'info')
    const env = {
      OIDC_JWKS_KEY_4: jwk('kid-4'),
      OIDC_JWKS_KEY_5: jwk('kid-5')
    }

    signingJwks(env, 5)

    expect(info.mock.calls).toEqual([
      ['[oidcKeys] 2 signing keys loaded'],
      ['[oidcKeys] Signing with OIDC_JWKS_KEY_5'],
      ['[oidcKeys] Loaded OIDC_JWKS_KEY_5: kid-5'],
      ['[oidcKeys] Loaded OIDC_JWKS_KEY_4: kid-4']
    ])
  })

  it('refuses a key that is not JSON, and names the setting', () => {
    const env = {
      OIDC_JWKS_KEY_1: jwk('kid-1'),
      OIDC_JWKS_KEY_2: '{"kty":"RSA","kid":"cut-off'
    }

    expect(() => signingJwks(env, 1)).toThrow(
      "Couldn't parse JWK as JSON in OIDC_JWKS_KEY_2"
    )
  })

  it('refuses a key with no kid, and names the setting', () => {
    const env = {
      OIDC_JWKS_KEY_1: jwk('kid-1'),
      OIDC_JWKS_KEY_2: '{"kty":"RSA","d":"private-part"}'
    }

    expect(() => signingJwks(env, 1)).toThrow(
      'JWK in OIDC_JWKS_KEY_2 must be an object with a kid'
    )
  })

  it('refuses two keys with the same kid, and names the two settings', () => {
    const env = {
      OIDC_JWKS_KEY_1: jwk('same-kid'),
      OIDC_JWKS_KEY_2: jwk('same-kid')
    }

    expect(() => signingJwks(env, 2)).toThrow(
      'OIDC_JWKS_KEY_1 and OIDC_JWKS_KEY_2 have the same kid'
    )
  })

  it('returns the other keys from the lowest number to the highest', () => {
    const env = {
      OIDC_JWKS_KEY_10: jwk('kid-10'),
      OIDC_JWKS_KEY_3: jwk('kid-3'),
      OIDC_JWKS_KEY_1: jwk('kid-1'),
      OIDC_JWKS_KEY_2: jwk('kid-2')
    }

    expect(signingJwks(env, 3).map((key) => key.kid)).toEqual([
      'kid-3',
      'kid-1',
      'kid-2',
      'kid-10'
    ])
  })

  it('reads only names that are the prefix and a number', () => {
    const env = {
      OIDC_JWKS_KEY_1: jwk('one'),
      OIDC_JWKS_KEY_: jwk('no-number'),
      OIDC_JWKS_KEY_1A: jwk('letter'),
      MY_OIDC_JWKS_KEY_3: jwk('longer-name')
    }

    expect(signingJwks(env, 1).map((key) => key.kid)).toEqual(['one'])
  })

  it('reads a number with a leading zero as the same number', () => {
    const env = { OIDC_JWKS_KEY_07: jwk('seven') }

    expect(signingJwks(env, 7).map((key) => key.kid)).toEqual(['seven'])
  })

  it('refuses two names with the same number, and names the two settings', () => {
    const env = {
      OIDC_JWKS_KEY_1: jwk('one'),
      OIDC_JWKS_KEY_01: jwk('leading-zero')
    }

    expect(() => signingJwks(env, 1)).toThrow(
      'OIDC_JWKS_KEY_1 and OIDC_JWKS_KEY_01 have the same key number'
    )
  })

  it('refuses an empty key, and names the setting', () => {
    const env = { OIDC_JWKS_KEY_1: jwk('one'), OIDC_JWKS_KEY_2: '   ' }

    expect(() => signingJwks(env, 1)).toThrow('OIDC_JWKS_KEY_2 is empty')
  })

  it('refuses a pointer to a key that is not there', () => {
    const env = { OIDC_JWKS_KEY_1: jwk('kid-1') }

    expect(() => signingJwks(env, 100)).toThrow(
      'No key found with signing number 100'
    )
  })
})
