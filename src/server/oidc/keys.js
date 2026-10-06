import Joi from 'joi'

/**
 * Keys that are set as numbered environment variables, one key for each
 * variable, with a pointer that holds the number of the key that signs.
 *
 * A deployed secret can be written or deleted, and it cannot be read back.
 * With one variable for each key, a rotation adds a variable, moves the
 * pointer, then deletes the old variable, so that no step needs an old value.
 * The procedure is in docs/key-rotation.md.
 */

const JWKS_KEYS = {
  prefix: 'OIDC_JWKS_KEY_',
  pointerName: 'OIDC_JWKS_SIGNING_KEY'
}

const COOKIE_KEYS = {
  prefix: 'OIDC_COOKIE_KEY_',
  pointerName: 'OIDC_COOKIE_SIGNING_KEY'
}

/**
 * A key number is a whole number from 1, written without a leading zero, so
 * that each number has one variable name.
 */
const KEY_NUMBER = /^[1-9]\d*$/

/**
 * A reader of a token finds the key by its `kid`, so each signing key has
 * one. The provider checks the rest of the key when it starts.
 * @type {ObjectSchema<JWK & { kid: string }>}
 */
const jwkSchema = Joi.object({ kid: Joi.string().required() }).unknown()

/**
 * Reads the keys of one set, from the lowest number to the highest.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} prefix
 */
function readNumberedKeys(env, prefix) {
  /** @type {NumberedKey[]} */
  const keys = []

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || !value?.trim()) {
      continue
    }

    const suffix = name.slice(prefix.length)

    if (KEY_NUMBER.test(suffix)) {
      keys.push({ number: Number(suffix), name, value })
    }
  }

  // Environment variables come in no set order. Sorted, each container has
  // the keys in the same order.
  return keys.sort((a, b) => a.number - b.number)
}

/**
 * Moves the key that the pointer names to the front. The provider signs with
 * the first key in its list and accepts all of them.
 * @template {{ number: number }} Key
 * @param {Key[]} keys - from the lowest number to the highest
 * @param {{ prefix: string, pointerName: string }} keySet
 * @param {number} signingNumber - the value of the pointer
 * @returns {Key[]}
 */
function signingKeyFirst(keys, { prefix, pointerName }, signingNumber) {
  const signingKey = keys.find((key) => key.number === signingNumber)

  if (!signingKey) {
    const existingNumbers = keys.map((key) => key.number).join(', ')

    throw new Error(
      keys.length > 0
        ? `${pointerName} is ${signingNumber}, but the keys that exist are ${existingNumbers}`
        : `${pointerName} is ${signingNumber}, but no ${prefix}<n> is set`
    )
  }

  const otherKeys = keys.filter((key) => key !== signingKey)

  return [signingKey, ...otherKeys]
}

/**
 * Stops when two keys have the same `kid`, because a reader of a token could
 * then choose the wrong key.
 * @param {{ name: string, jwk: { kid: string } }[]} keys
 */
function checkEachKidIsInOneKey(keys) {
  /** @type {Map<string, string>} */
  const nameByKid = new Map()

  for (const { name, jwk } of keys) {
    const nameWithSameKid = nameByKid.get(jwk.kid)

    if (nameWithSameKid) {
      throw new Error(`${nameWithSameKid} and ${name} have the same kid`)
    }

    nameByKid.set(jwk.kid, name)
  }
}

/**
 * Reads one signing key. The error gives the name of the variable, and not
 * what the parser or joi found, so that no part of a private key can reach
 * a log.
 * @param {string} name - the variable that holds the key
 * @param {string} value
 */
function parseJwk(name, value) {
  const notAJwk = new Error(`${name} must be one JWK, as JSON, with a kid`)

  /** @type {unknown} */
  let json

  try {
    json = JSON.parse(value)
  } catch {
    throw notAJwk
  }

  return Joi.attempt(json, jwkSchema, notAJwk)
}

/**
 * The private keys that sign ID tokens and access tokens, signing key first.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} signingNumber - the value of OIDC_JWKS_SIGNING_KEY
 */
export function signingJwks(env, signingNumber) {
  const keys = readNumberedKeys(env, JWKS_KEYS.prefix).map(
    ({ number, name, value }) => ({
      number,
      name,
      jwk: parseJwk(name, value)
    })
  )

  checkEachKidIsInOneKey(keys)

  return signingKeyFirst(keys, JWKS_KEYS, signingNumber).map(
    ({ number, jwk }) => ({ number, jwk })
  )
}

/**
 * The keys that sign the provider cookies, signing key first.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} signingNumber - the value of OIDC_COOKIE_SIGNING_KEY
 */
export function cookieKeys(env, signingNumber) {
  const keys = readNumberedKeys(env, COOKIE_KEYS.prefix)

  return signingKeyFirst(keys, COOKIE_KEYS, signingNumber).map(
    ({ number, value }) => ({ number, value })
  )
}

/**
 * @typedef {object} NumberedKey
 * @property {number} number - the number at the end of the variable name
 * @property {string} name - the full variable name
 * @property {string} value - the key, as it is set in the variable
 */

/**
 * @import { ObjectSchema } from 'joi'
 * @import { JWK } from 'oidc-provider'
 */
