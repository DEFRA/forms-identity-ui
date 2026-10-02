/**
 * Generates the assertion keypair a client uses to prove itself
 * (private_key_jwt), printing both halves.
 *
 * The two halves go to different services and must never be swapped:
 *   private → the client, as one JWK: forms-runner's OIDC_CLIENT_PRIVATE_JWK,
 *             or the example RP's EXAMPLE_RP_PRIVATE_JWK. Never leaves it.
 *   public  → this service, as OIDC_RUNNER_JWKS. Enough to verify the
 *             client's signature, useless for forging one.
 *
 * Usage: node scripts/generate-client-keypair.mjs
 */
import { generateClientKeypair } from './jwks.cjs'

const { private: privateJwks, public: publicJwks } = generateClientKeypair()
const [privateJwk] = privateJwks.keys

process.stdout.write(
  [
    '# The client keeps this (forms-runner, or EXAMPLE_RP_PRIVATE_JWK locally):',
    `OIDC_CLIENT_PRIVATE_JWK=${JSON.stringify(privateJwk)}`,
    '',
    '# This service registers this (public half only):',
    `OIDC_RUNNER_JWKS=${JSON.stringify(publicJwks)}`,
    ''
  ].join('\n')
)
