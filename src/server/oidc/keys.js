import Joi from 'joi'

import { logger } from '~/src/server/common/helpers/logging/logger.js'

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
  namePattern: /^OIDC_JWKS_KEY_(\d+)$/,
  prefix: 'OIDC_JWKS_KEY_',
  pointerName: 'OIDC_JWKS_SIGNING_KEY'
}

/**
 * A reader of a token finds the key by its `kid`, so each signing key has
 * one. The provider checks the rest of the key when it starts.
 * @type {ObjectSchema<JWK & { kid: string }>}
 */
const jwkSchema = Joi.object({ kid: Joi.string().required() }).unknown()

/**
 * Reads and parses the keys of one set, from the lowest number to the
 * highest. Stops when two names have the same number, such as `_1` and
 * `_01`, because an operator could then change one and leave the other.
 * @template Value
 * @param {NodeJS.ProcessEnv} env
 * @param {RegExp} namePattern - captures the key number from a variable name
 * @param {(name: string, value: string) => Value} parse - turns the value of
 *   one variable into the key that the provider takes
 */
function readNumberedKeys(env, namePattern, parse) {
  /** @type {Map<number, NumberedKey<Value>>} */
  const keyByNumber = new Map()

  for (const [name, value] of Object.entries(env)) {
    const digits = namePattern.exec(name)?.[1]

    if (!digits || !value?.trim()) {
      continue
    }

    const number = Number(digits)
    const keyWithSameNumber = keyByNumber.get(number)

    if (keyWithSameNumber) {
      throw new Error(
        `${keyWithSameNumber.name} and ${name} have the same key number`
      )
    }

    keyByNumber.set(number, { number, name, value: parse(name, value) })
  }

  const keys = [...keyByNumber.values()]

  // Environment variables come in no set order. Sorted, the startup log and
  // the JWKS endpoint list the keys in the same order in each container.
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
 * @param {NumberedKey<{ kid: string }>[]} keys
 */
function verifyNoDuplicateKeys(keys) {
  /** @type {Map<string, string>} */
  const nameByKid = new Map()

  for (const { name, value } of keys) {
    const nameWithSameKid = nameByKid.get(value.kid)

    if (nameWithSameKid) {
      throw new Error(`${nameWithSameKid} and ${name} have the same kid`)
    }

    nameByKid.set(value.kid, name)
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

  const { error, value: jwk } = jwkSchema.validate(json)

  if (error) {
    throw notAJwk
  }

  return jwk
}

/**
 * The private keys that sign ID tokens and access tokens, signing key first,
 * in the form that the provider takes. Logs which keys are loaded.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} signingNumber - the value of OIDC_JWKS_SIGNING_KEY
 */
export function signingJwks(env, signingNumber) {
  const keys = readNumberedKeys(env, JWKS_KEYS.namePattern, parseJwk)

  verifyNoDuplicateKeys(keys)

  const signingFirst = signingKeyFirst(keys, JWKS_KEYS, signingNumber)

  logger.info(`[oidcKeys] ${keys.length} signing keys loaded`)
  logger.info(`[oidcKeys] Signing with ${signingFirst[0].name}`)

  // A `kid` is public, so the log can show which key is which
  for (const { name, value } of keys) {
    logger.info(`[oidcKeys] Loaded ${name}: ${value.kid}`)
  }

  return signingFirst.map(({ value }) => value)
}

/**
 * @template Value
 * @typedef {object} NumberedKey
 * @property {number} number - the number at the end of the variable name
 * @property {string} name - the full variable name
 * @property {Value} value - the key, parsed from the variable
 */

/**
 * @import { ObjectSchema } from 'joi'
 * @import { JWK } from 'oidc-provider'
 */
