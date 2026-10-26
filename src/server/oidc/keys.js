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

/**
 * Captures the key number from the name of a signing key variable
 */
const JWKS_KEY_NAME = /^OIDC_JWKS_KEY_(\d+)$/

/**
 * Captures the key number from the name of a cookie key variable
 */
const COOKIE_KEY_NAME = /^OIDC_COOKIE_KEY_(\d+)$/

/**
 * A reader of a token finds the key by its `kid`, so each signing key has
 * one. The provider checks the rest of the key when it starts.
 * @type {ObjectSchema<SigningJwk>}
 */
const jwkSchema = Joi.object({ kid: Joi.string().required() }).unknown()

/**
 * Reads and parses the keys of one set, from the lowest number to the
 * highest.
 * @template Value
 * @param {NodeJS.ProcessEnv} env
 * @param {RegExp} namePattern - captures the key number from a variable name
 * @param {ParseKey<Value>} parse - turns the value of
 *   one variable into the key that the provider takes
 */
function readNumberedKeys(env, namePattern, parse) {
  /** @type {Map<number, NumberedKey<Value>>} */
  const keyByNumber = new Map()

  for (const [name, value] of Object.entries(env)) {
    const digits = namePattern.exec(name)?.[1]

    if (!digits) {
      continue
    }

    if (!value?.trim()) {
      throw new Error(`${name} is empty`)
    }

    const number = Number(digits)
    if (keyByNumber.get(number)) {
      throw new Error(
        `${keyByNumber.get(number)?.name} and ${name} have the same key number`
      )
    }

    keyByNumber.set(number, { number, name, value: parse(name, value) })
  }

  // Environment variables come in no set order. Sorted, the startup log and
  // the JWKS endpoint list the keys in the same order in each container.
  return [...keyByNumber.values()].sort((a, b) => a.number - b.number)
}

/**
 * Moves the key that the pointer names to the front. The provider signs with
 * the first key in its list and accepts all of them.
 * @template Value
 * @param {NumberedKey<Value>[]} keys - from the lowest number to the highest
 * @param {number} signingNumber - the value of the pointer
 * @returns {NumberedKey<Value>[]}
 */
function signingKeyFirst(keys, signingNumber) {
  const signingKey = keys.find((key) => key.number === signingNumber)

  if (!signingKey) {
    throw new Error(`No key found with signing number ${signingNumber}`)
  }

  const otherKeys = keys.filter((key) => key !== signingKey)

  return [signingKey, ...otherKeys]
}

/**
 * Stops when two keys have the same `kid`, because a reader of a token could
 * then choose the wrong key.
 * @param {NumberedKey<SigningJwk>[]} keys
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
  /** @type {unknown} */
  let json

  try {
    json = JSON.parse(value)
  } catch {
    throw new Error(`Couldn't parse JWK as JSON in ${name}`)
  }

  const { error, value: jwk } = jwkSchema.validate(json)

  if (error) {
    throw new Error(`JWK in ${name} must be an object with a kid`)
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
  const unvalidatedKeys = readNumberedKeys(env, JWKS_KEY_NAME, parseJwk)

  verifyNoDuplicateKeys(unvalidatedKeys)

  const keys = signingKeyFirst(unvalidatedKeys, signingNumber)

  logger.info(`[oidcKeys] ${keys.length} signing keys loaded`)
  logger.info(`[oidcKeys] Signing with ${keys[0].name}`)

  // A `kid` is public, so the log can show which key is which
  for (const { name, value } of keys) {
    logger.info(`[oidcKeys] Loaded ${name}: ${value.kid}`)
  }

  return keys.map(({ value }) => value)
}

/**
 * The keys that sign the provider cookies, signing key first, in the form
 * that the provider takes. Logs which keys are loaded.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} signingNumber - the value of OIDC_COOKIE_SIGNING_KEY
 */
export function cookieKeys(env, signingNumber) {
  // The provider takes a cookie key as the text that is set
  const unvalidatedKeys = readNumberedKeys(
    env,
    COOKIE_KEY_NAME,
    (_name, value) => value
  )
  const keys = signingKeyFirst(unvalidatedKeys, signingNumber)

  logger.info(`[oidcKeys] ${keys.length} cookie keys loaded`)
  logger.info(`[oidcKeys] Signing with ${keys[0].name}`)

  // A cookie key has no public name, so the log shows only the variable
  for (const { name } of keys) {
    logger.info(`[oidcKeys] Loaded ${name}`)
  }

  return keys.map(({ value }) => value)
}

/**
 * @template Value
 * @typedef {object} NumberedKey
 * @property {number} number - the number at the end of the variable name
 * @property {string} name - the full variable name
 * @property {Value} value - the key, parsed from the variable
 */

/**
 * @template Value
 * @typedef {(name: string, value: string) => Value} ParseKey
 */

/**
 * @typedef {JWK & { kid: string }} SigningJwk
 */

/**
 * @import { ObjectSchema } from 'joi'
 * @import { JWK } from 'oidc-provider'
 */
