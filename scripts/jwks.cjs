const crypto = require('node:crypto')

/**
 * Key generation for the OIDC provider and its clients. CommonJS so the CLI
 * scripts (ESM) and jest.setup.cjs share one implementation.
 *
 * Everything is ES256 over P-256 — the algorithm GOV.UK One Login requires,
 * so staying on it keeps a future move to One Login a change of
 * configuration rather than of code.
 */

const CURVE = 'P-256'
const ALG = 'ES256'

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
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: CURVE
  })
  const kid = `${role}-${ALG.toLowerCase()}-${crypto.randomBytes(6).toString('hex')}`

  /**
   * @param {crypto.KeyObject} key
   */
  const jwks = (key) => ({
    keys: [{ ...key.export({ format: 'jwk' }), use: 'sig', alg: ALG, kid }]
  })

  return { private: jwks(privateKey), public: jwks(publicKey) }
}

/**
 * The provider's own signing JWKS (private). It signs ID tokens; the public
 * half is published at the JWKS endpoint for clients to verify against.
 */
function generateJwks() {
  return generateKeyPair('sig').private
}

/**
 * A client's assertion keypair. The client keeps the private half and proves
 * itself with it (private_key_jwt); this service is configured with the
 * public half alone, so nothing here can forge the client.
 */
function generateClientKeypair() {
  return generateKeyPair('runner')
}

module.exports = { generateClientKeypair, generateJwks }
