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
 * Reads the keys of one set. The signing key is first, because the provider
 * signs with the first key and accepts all of them. The others go from the
 * highest number to the lowest, so the newest key is tried first.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ prefix: string, pointerName: string, signingNumber: number }} keySet
 * @returns {NumberedKey[]}
 */
export function readNumberedKeys(env, { prefix, pointerName, signingNumber }) {
  /** @type {NumberedKey[]} */
  const keys = []

  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(prefix) || !value?.trim()) {
      continue
    }

    const suffix = name.slice(prefix.length)

    if (/^[1-9]\d*$/.test(suffix)) {
      keys.push({ number: Number(suffix), name, value })
    }
  }

  keys.sort((a, b) => b.number - a.number)

  const signingKey = keys.find((key) => key.number === signingNumber)

  if (!signingKey) {
    const existing = keys
      .map((key) => key.number)
      .reverse()
      .join(', ')

    throw new Error(
      keys.length > 0
        ? `${pointerName} is ${signingNumber}, but the keys that exist are ${existing}`
        : `${pointerName} is ${signingNumber}, but no ${prefix}<n> is set`
    )
  }

  return [signingKey, ...keys.filter((key) => key !== signingKey)]
}

/**
 * Reads one JWK. An error gives the name of the setting and never the value,
 * so that a private key cannot reach a log.
 * @param {NumberedKey} key
 * @returns {JWK & { kid: string }}
 */
function parseJwk({ name, value }) {
  /** @type {unknown} */
  let parsed

  try {
    parsed = JSON.parse(value)
  } catch {
    parsed = undefined
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('kid' in parsed) ||
    typeof parsed.kid !== 'string' ||
    parsed.kid === ''
  ) {
    throw new Error(`${name} must be one JWK, as JSON, with a kid`)
  }

  return /** @type {JWK & { kid: string }} */ (parsed)
}

/**
 * The private keys that sign ID tokens and access tokens, signing key first.
 * A reader of a token finds the key by its `kid`, so each `kid` is in one
 * key only.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} signingNumber - the value of OIDC_JWKS_SIGNING_KEY
 */
export function signingJwks(env, signingNumber) {
  const keys = readNumberedKeys(env, { ...JWKS_KEYS, signingNumber }).map(
    (key) => ({ number: key.number, name: key.name, jwk: parseJwk(key) })
  )

  /** @type {Map<string, string>} */
  const nameByKid = new Map()

  for (const { name, jwk } of [...keys].sort((a, b) => a.number - b.number)) {
    const other = nameByKid.get(jwk.kid)

    if (other) {
      throw new Error(`${other} and ${name} have the same kid`)
    }

    nameByKid.set(jwk.kid, name)
  }

  return keys.map(({ number, jwk }) => ({ number, jwk }))
}

/**
 * The keys that sign the provider cookies, signing key first.
 * @param {NodeJS.ProcessEnv} env
 * @param {number} signingNumber - the value of OIDC_COOKIE_SIGNING_KEY
 */
export function cookieKeys(env, signingNumber) {
  return readNumberedKeys(env, { ...COOKIE_KEYS, signingNumber }).map(
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
 * @import { JWK } from 'oidc-provider'
 */
