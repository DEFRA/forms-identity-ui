process.env.NODE_ENV = 'test'
process.env.PORT = '3011'

process.env.LOG_ENABLED = 'false'
process.env.LOG_LEVEL = 'silent'
process.env.LOG_FORMAT = 'pino-pretty'

process.env.TRACING_HEADER = 'x-cdp-request-id'

process.env.REDIS_HOST = 'dummy'
process.env.REDIS_USERNAME = 'dummy'
process.env.REDIS_PASSWORD = 'dummy'
process.env.REDIS_KEY_PREFIX = 'forms-identity-ui:'
process.env.USE_SINGLE_INSTANCE_CACHE = 'true'
process.env.REDIS_TLS = 'false'

process.env.SESSION_CACHE_ENGINE = 'memory'
process.env.SESSION_COOKIE_PASSWORD =
  'the-test-session-cookie-password-at-least-32-characters-long'
process.env.SESSION_COOKIE_SECURE = 'false'

// OIDC provider secrets — throwaway per-run keys (tests are not a deployment;
// deployed environments must supply stable keys via CDP secrets)
const {
  generateClientKeypair,
  generateSigningJwk
} = require('./scripts/jwks.cjs')

const runnerKeypair = generateClientKeypair()

// Two keys in each set with the pointer at the second, as in a rotation
// after the pointer has moved
process.env.OIDC_JWKS_KEY_20261001 = JSON.stringify(generateSigningJwk())
process.env.OIDC_JWKS_KEY_20261026 = JSON.stringify(generateSigningJwk())
process.env.OIDC_JWKS_SIGNING_KEY = '20261026'
process.env.OIDC_COOKIE_KEY_20261001 = 'test-cookie-key-1'
process.env.OIDC_COOKIE_KEY_20261026 = 'test-cookie-key-2'
process.env.OIDC_COOKIE_SIGNING_KEY = '20261026'
// the provider is given the public half; tests needing to act as the client
// sign with the private half
process.env.OIDC_RUNNER_JWKS = JSON.stringify(runnerKeypair.public)
process.env.OIDC_RUNNER_PRIVATE_JWKS = JSON.stringify(runnerKeypair.private)
process.env.OIDC_TTL_AUTHORIZATION_CODE = '60'
process.env.OIDC_TTL_ID_TOKEN = '300'
// Short, because the client refreshes it with a refresh token
process.env.OIDC_TTL_ACCESS_TOKEN = '300'
process.env.OIDC_TTL_REFRESH_TOKEN = '604800'
process.env.OIDC_TTL_INTERACTION = '3600'
process.env.OIDC_TTL_SESSION = '86400'
process.env.OIDC_TTL_GRANT = '604800'
// Pin values a local .env could otherwise leak into tests (dotenv does not
// override variables that are already set)
process.env.OIDC_ISSUER = 'http://localhost:3011'
process.env.IDENTITY_API_URL = 'http://localhost:3010'
process.env.OIDC_RESOURCE_SERVERS =
  'urn:defra:forms:forms-submission-api,urn:defra:forms:another-api'
process.env.OIDC_RUNNER_REDIRECT_URIS =
  'http://localhost:3009/callback,http://localhost:3000/callback,https://forms-runner.dev-env.cloud/auth/callback'
process.env.OIDC_RUNNER_POST_LOGOUT_REDIRECT_URIS =
  'http://localhost:3009/auth/signed-out,http://localhost:3000/'
process.env.OIDC_RUNNER_BACKCHANNEL_LOGOUT_URI =
  'http://localhost:3009/auth/backchannel-logout'
process.env.OIDC_RUNNER_INITIATE_LOGIN_URI =
  'http://localhost:3009/auth/initiate'
