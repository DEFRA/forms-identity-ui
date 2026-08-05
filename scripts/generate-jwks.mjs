/**
 * Generates a private RSA JWKS for the OIDC provider. Put the output in .env
 * as OIDC_JWKS (identical across containers — keys are never boot-generated).
 *
 * Usage: node scripts/generate-jwks.mjs
 */
// eslint-disable-next-line no-restricted-imports -- runs under plain node (no ~ alias resolution)
import { generateJwks } from './jwks.cjs'

process.stdout.write(`${JSON.stringify(generateJwks())}\n`)
