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
 * @param {string} kid - key id, carried in signed headers so a reader knows which key to verify with
 */
function generateKeyPair(kid) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: CURVE
  })

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
  return generateKeyPair('sig-1').private
}

/**
 * A client's assertion keypair. The client keeps the private half and proves
 * itself with it (private_key_jwt); this service is configured with the
 * public half alone, so nothing here can forge the client.
 */
function generateClientKeypair() {
  return generateKeyPair('runner-1')
}

module.exports = { generateClientKeypair, generateJwks }
