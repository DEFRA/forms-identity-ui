const crypto = require('node:crypto')

/**
 * Generates a private RSA signing JWKS for the OIDC provider. CommonJS so
 * the CLI script (ESM) and jest.setup.cjs share one implementation.
 */
function generateJwks() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048
  })
  const jwk = privateKey.export({ format: 'jwk' })

  return { keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid: 'sig-1' }] }
}

module.exports = { generateJwks }
