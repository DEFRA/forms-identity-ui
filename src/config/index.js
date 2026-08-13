import { resolve } from 'node:path'

import convict from 'convict'

import 'dotenv/config'

const isProduction = process.env.NODE_ENV === 'production'
const isDev = process.env.NODE_ENV !== 'production'
const isTest = process.env.NODE_ENV === 'test'

const fourHoursMs = 14400000
const oneWeekSeconds = 604800

export const config = convict({
  appDir: {
    format: String,
    default: resolve(import.meta.dirname, '../server')
  },
  publicDir: {
    format: String,
    default: resolve(import.meta.dirname, '../../.public')
  },
  staticCacheMaxAge: {
    doc: 'How long browsers and shared caches may keep a static file whose name carries no content hash, in seconds. Bounds how long a rebrand or a govuk-frontend upgrade can go unnoticed.',
    format: 'nat',
    default: oneWeekSeconds,
    env: 'STATIC_CACHE_MAX_AGE'
  },

  /**
   * Server
   */
  host: {
    doc: 'The IP address to bind',
    format: String,
    default: '0.0.0.0',
    env: 'HOST'
  },
  port: {
    format: 'port',
    default: 3011,
    env: 'PORT'
  },
  env: {
    doc: 'The application environment.',
    format: ['production', 'development', 'test'],
    default: 'development',
    env: 'NODE_ENV'
  },

  /**
   * Helper flags
   */
  isProduction: {
    doc: 'If this application running in the production environment',
    format: Boolean,
    default: isProduction
  },
  isDevelopment: {
    doc: 'If this application running in the development environment',
    format: Boolean,
    default: isDev
  },
  isTest: {
    doc: 'If this application running in the test environment',
    format: Boolean,
    default: isTest
  },

  /**
   * Service
   */
  serviceName: {
    doc: 'Applications Service Name',
    format: String,
    default: 'forms-identity-ui'
  },

  /**
   * Logging
   */
  log: {
    enabled: {
      doc: 'Is logging enabled',
      format: Boolean,
      default: !isTest,
      env: 'LOG_ENABLED'
    },
    level: {
      doc: 'Logging level',
      format: ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'],
      default: /** @type {LevelWithSilent} */ ('info'),
      env: 'LOG_LEVEL'
    },
    format: {
      doc: 'Format to output logs in.',
      format: ['ecs', 'pino-pretty'],
      default: /** @type {'ecs' | 'pino-pretty'} */ (
        isProduction ? 'ecs' : 'pino-pretty'
      ),
      env: 'LOG_FORMAT'
    },
    redact: {
      doc: 'Log paths to redact',
      format: Array,
      default: isProduction
        ? ['req.headers.authorization', 'req.headers.cookie', 'res.headers']
        : ['req', 'res', 'responseTime'],
      env: 'LOG_REDACT'
    }
  },

  /**
   * Tracing
   */
  tracing: {
    header: {
      doc: 'Tracing header name',
      format: String,
      default: 'x-cdp-request-id',
      env: 'TRACING_HEADER'
    }
  },

  /**
   * Session cache
   * Redis integration is optional, but recommended for production environments.
   */
  redis: {
    host: {
      doc: 'Redis cache host',
      format: String,
      default: '127.0.0.1',
      env: 'REDIS_HOST'
    },
    username: {
      doc: 'Redis cache username',
      format: String,
      default: '',
      env: 'REDIS_USERNAME'
    },
    password: {
      doc: 'Redis cache password',
      format: '*',
      default: '',
      sensitive: true,
      env: 'REDIS_PASSWORD'
    },
    keyPrefix: {
      doc: 'Redis cache key prefix name used to isolate the cached results across multiple clients',
      format: String,
      default: 'forms-identity-ui:',
      env: 'REDIS_KEY_PREFIX'
    },
    useSingleInstanceCache: {
      doc: 'Redis use single cache (non-clustered)',
      format: Boolean,
      default: !isProduction,
      env: 'USE_SINGLE_INSTANCE_CACHE'
    },
    useTLS: {
      doc: 'Connect to Redis using TLS',
      format: Boolean,
      default: isProduction,
      env: 'REDIS_TLS'
    }
  },
  session: {
    cache: {
      engine: {
        doc: 'Backing cache engine for the session cache',
        format: ['redis', 'memory'],
        default: /** @type {'redis' | 'memory'} */ (
          isProduction ? 'redis' : 'memory'
        ),
        env: 'SESSION_CACHE_ENGINE'
      },
      name: {
        doc: 'Server-side session cache name',
        format: String,
        default: 'session',
        env: 'SESSION_CACHE_NAME'
      },
      ttl: {
        doc: 'Server-side session cache TTL in milliseconds',
        format: Number,
        default: fourHoursMs,
        env: 'SESSION_CACHE_TTL'
      }
    },
    cookie: {
      ttl: {
        doc: 'Session cookie TTL in milliseconds',
        format: Number,
        default: fourHoursMs,
        env: 'SESSION_COOKIE_TTL'
      },
      password: {
        doc: 'Session cookie password, at least 32 characters (no default in production)',
        format: String,
        default: isProduction
          ? /** @type {string | null} */ (null)
          : 'the-local-dev-session-cookie-password-at-least-32-characters',
        sensitive: true,
        env: 'SESSION_COOKIE_PASSWORD'
      },
      secure: {
        doc: 'Set the secure flag on the session cookie',
        format: Boolean,
        default: isProduction,
        env: 'SESSION_COOKIE_SECURE'
      }
    }
  },

  /**
   * OIDC provider (this service is the issuer). Every value is required —
   * the service refuses to start without them, so a misconfigured
   * environment fails loudly at boot rather than at first sign-in. Secrets
   * are never boot-generated: generated keys break horizontal scaling.
   */
  oidc: {
    issuer: {
      doc: 'Public issuer origin (this service). TLS is terminated upstream.',
      format: String,
      default: /** @type {string | null} */ (null),
      env: 'OIDC_ISSUER'
    },
    jwks: {
      doc: 'Private JWKS JSON (run `node scripts/generate-jwks.mjs`)',
      format: String,
      default: /** @type {string | null} */ (null),
      sensitive: true,
      env: 'OIDC_JWKS'
    },
    cookieKeys: {
      doc: 'Comma-separated cookie signing keys, identical across containers',
      format: String,
      default: /** @type {string | null} */ (null),
      sensitive: true,
      env: 'OIDC_COOKIE_KEYS'
    },
    cookieSecure: {
      doc: 'Secure flag on provider cookies (off for local http)',
      format: Boolean,
      default: isProduction,
      env: 'OIDC_COOKIE_SECURE'
    },
    runnerJwks: {
      doc: 'Public JWKS of the `runner` client, whose private half signs the assertion it authenticates with (run `node scripts/generate-client-keypair.mjs`). Public key material, so not a secret.',
      format: String,
      default: /** @type {string | null} */ (null),
      env: 'OIDC_RUNNER_JWKS'
    },
    runnerRedirectUris: {
      doc: 'Comma-separated redirect_uris for the runner client',
      format: String,
      default: /** @type {string | null} */ (null),
      env: 'OIDC_RUNNER_REDIRECT_URIS'
    },
    ttl: {
      authorizationCode: {
        doc: 'Authorization code lifetime in seconds',
        format: 'nat',
        default: /** @type {number | null} */ (null),
        env: 'OIDC_TTL_AUTHORIZATION_CODE'
      },
      idToken: {
        doc: 'ID token lifetime in seconds',
        format: 'nat',
        default: /** @type {number | null} */ (null),
        env: 'OIDC_TTL_ID_TOKEN'
      },
      accessToken: {
        doc: 'Access token lifetime in seconds',
        format: 'nat',
        default: /** @type {number | null} */ (null),
        env: 'OIDC_TTL_ACCESS_TOKEN'
      },
      interaction: {
        doc: 'Sign-in interaction lifetime in seconds',
        format: 'nat',
        default: /** @type {number | null} */ (null),
        env: 'OIDC_TTL_INTERACTION'
      },
      session: {
        doc: 'Provider session lifetime in seconds',
        format: 'nat',
        default: /** @type {number | null} */ (null),
        env: 'OIDC_TTL_SESSION'
      },
      grant: {
        doc: 'Grant lifetime in seconds',
        format: 'nat',
        default: /** @type {number | null} */ (null),
        env: 'OIDC_TTL_GRANT'
      }
    }
  },
  identityApi: {
    url: {
      doc: 'Internal base URL of forms-identity-api',
      format: String,
      default: /** @type {string | null} */ (null),
      env: 'IDENTITY_API_URL'
    }
  },

  /**
   * Networking
   */
  httpProxy: {
    doc: 'HTTP proxy URL',
    format: String,
    default: /** @type {string | null} */ (null),
    nullable: true,
    env: 'HTTP_PROXY'
  },
  isSecureContextEnabled: {
    doc: 'Enable the TLS secure context using TRUSTSTORE_ certificates',
    format: Boolean,
    default: false,
    env: 'ENABLE_SECURE_CONTEXT'
  }
})

config.validate({ allowed: 'strict' })

/**
 * @import { LevelWithSilent } from 'pino'
 */
