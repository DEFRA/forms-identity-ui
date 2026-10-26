const crypto = require('node:crypto')

const { SIGNING_ALG } = require('../src/server/constants.js')

/**
 * Key generation for the OIDC provider and its clients. CommonJS so the CLI
 * scripts (ESM) and jest.setup.cjs share one implementation.
 *
 * Everything is RS256. A reader verifies these keys with a stock JWKS
 * reader, and those read RSA keys.
 */

const MODULUS_LENGTH = 2048

/**
 * A key id travels in the header of everything the key signs, and it is all
 * a reader has to go on when choosing which key to verify with. It names the
 * role and the algorithm, so a key found on a developer machine or in an old
 * backup can be placed on sight, and ends in a random tail, so a key that
 * replaces a live one is a different key by name as well as by material.
 * @param {string} role - 'sig' for the key this service signs with, 'runner'
 *   for the one a client signs its assertions with
 */
function generateKeyPair(role) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: MODULUS_LENGTH
  })

  const kid = `${role}-${SIGNING_ALG.toLowerCase()}-${crypto.randomBytes(6).toString('hex')}`

  /**
   * @param {crypto.KeyObject} key
   */
  const jwk = (key) => ({
    ...key.export({ format: 'jwk' }),
    use: 'sig',
    alg: SIGNING_ALG,
    kid
  })

  return { private: jwk(privateKey), public: jwk(publicKey) }
}

/**
 * One private key for the provider to sign ID tokens and access tokens with.
 * The public half is published at the JWKS endpoint for clients and APIs to
 * verify against.
 */
function generateSigningJwk() {
  return generateKeyPair('sig').private
}

/**
 * A client's assertion keypair. The client keeps the private half and proves
 * itself with it (private_key_jwt); this service is configured with the
 * public half alone, so nothing here can forge the client.
 *
 * Each half is a JWKS, because OIDC_RUNNER_JWKS is a list that holds the old
 * and the new public half during a rotation.
 */
function generateClientKeypair() {
  const keyPair = generateKeyPair('runner')

  return {
    private: { keys: [keyPair.private] },
    public: { keys: [keyPair.public] }
  }
}

module.exports = { generateClientKeypair, generateSigningJwk }
