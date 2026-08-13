/**
 * Generates the provider's private signing JWKS (ES256). Put the output in .env
 * as OIDC_JWKS (identical across containers — keys are never boot-generated).
 *
 * Usage: node scripts/generate-jwks.mjs
 */
import { generateJwks } from './jwks.cjs'

process.stdout.write(`${JSON.stringify(generateJwks())}\n`)
