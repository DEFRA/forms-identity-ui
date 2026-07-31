/**
 * Generates a private RSA JWKS for the OIDC provider. Put the output in .env
 * as OIDC_JWKS (identical across containers — keys are never boot-generated).
 *
 * Usage: node scripts/generate-jwks.mjs
 */
import crypto from 'node:crypto'

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048
})
const jwk = privateKey.export({ format: 'jwk' })
const full = { ...jwk, use: 'sig', alg: 'RS256', kid: 'sig-1' }

process.stdout.write(`${JSON.stringify({ keys: [full] })}\n`)
