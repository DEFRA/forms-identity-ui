/**
 * Generates one private signing key (RS256) for the provider. Put the output
 * in .env as OIDC_JWKS_KEY_<YYYYMMDD>, where <YYYYMMDD> is the date the key
 * is added, identical across containers. Keys are never boot-generated. docs/key-rotation.md has
 * the procedure to bring a new key into use.
 *
 * Usage: node scripts/generate-jwks.mjs
 */
import { generateSigningJwk } from './jwks.cjs'

process.stdout.write(`${JSON.stringify(generateSigningJwk())}\n`)
