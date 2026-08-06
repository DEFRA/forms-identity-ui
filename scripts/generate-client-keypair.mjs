/**
 * Generates the assertion keypair a client uses to prove itself
 * (private_key_jwt), printing both halves.
 *
 * The two halves go to different services and must never be swapped:
 *   private → the client (forms-runner, or the example RP's
 *             EXAMPLE_RP_PRIVATE_JWKS). Never leaves it.
 *   public  → this service, as OIDC_RUNNER_JWKS. Enough to verify the
 *             client's signature, useless for forging one.
 *
 * Usage: node scripts/generate-client-keypair.mjs
 */
import { generateClientKeypair } from './jwks.cjs'

const { private: privateJwks, public: publicJwks } = generateClientKeypair()

process.stdout.write(
  [
    '# The client keeps this (forms-runner / example RP):',
    `EXAMPLE_RP_PRIVATE_JWKS=${JSON.stringify(privateJwks)}`,
    '',
    '# This service registers this (public half only):',
    `OIDC_RUNNER_JWKS=${JSON.stringify(publicJwks)}`,
    ''
  ].join('\n')
)
