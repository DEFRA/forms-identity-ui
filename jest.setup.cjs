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
const crypto = require('node:crypto')

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048
})
process.env.OIDC_JWKS = JSON.stringify({
  keys: [
    {
      ...privateKey.export({ format: 'jwk' }),
      use: 'sig',
      alg: 'RS256',
      kid: 'sig-1'
    }
  ]
})
process.env.OIDC_COOKIE_KEYS = 'test-cookie-key-1,test-cookie-key-2'
process.env.OIDC_CLIENT_SECRET = 'test-client-secret'
