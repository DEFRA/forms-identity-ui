import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { ProxyAgent } from 'proxy-agent'

import { config } from '~/src/config/index.js'

const CACHE_SEGMENT = 'service-token'
const CACHE_KEY = 'identity-api'

// Retire a cached token before STS expires it, so a request never carries
// a token that expires while the request is still in progress.
const TTL_SAFETY_MARGIN = 0.8

/**
 * Set when the plugin registers. The OIDC adapter is constructed by
 * `oidc-provider` with no request in scope, so the policy is reached from
 * module scope rather than threaded through the lib layer.
 * @type {Policy<string, PolicyOptions<string>> | undefined}
 */
let tokenCache

/**
 * The cache lifetime for a minted token, in milliseconds.
 *
 * STS's own `Expiration` wins when present, so if STS shortened the
 * requested duration the cache does not outlive the token; the requested
 * duration is the fallback for a response that omits `Expiration`, or for
 * an `Expiration` that has already passed.
 * @param {Date | undefined} expiration
 * @param {number} requestedDurationSeconds
 * @returns {number}
 */
export function tokenTtlMs(expiration, requestedDurationSeconds) {
  const untilExpiry = expiration ? expiration.getTime() - Date.now() : 0
  const availableMs =
    untilExpiry > 0 ? untilExpiry : requestedDurationSeconds * 1000

  return Math.floor(availableMs * TTL_SAFETY_MARGIN)
}

/**
 * Mints a token identifying this service to forms-identity-api.
 *
 * The subject is set by STS from the container's own credentials, so the
 * receiving service can tell who called rather than only that the caller knew
 * a shared secret.
 * @param {STSClient} sts
 * @param {GenerateFuncFlags} flags
 * @returns {Promise<string>}
 */
async function mintToken(sts, flags) {
  const durationSeconds = config.get('identityApi.tokenDurationSeconds')
  const { WebIdentityToken, Expiration } = await sts.send(
    new GetWebIdentityTokenCommand({
      SigningAlgorithm: 'RS256',
      Audience: [config.get('identityApi.audience')],
      DurationSeconds: durationSeconds
    })
  )

  if (!WebIdentityToken) {
    throw new Error('STS returned no web identity token')
  }

  flags.ttl = tokenTtlMs(Expiration, durationSeconds)

  return WebIdentityToken
}

/**
 * The current caller token, minted on demand and reused until it nears expiry
 * @returns {Promise<string>}
 */
export async function getServiceToken() {
  if (!tokenCache) {
    throw new Error('service-token plugin has not been registered')
  }

  const token = await tokenCache.get(CACHE_KEY)

  // A configured generateFunc always returns a value or throws, so a null
  // here would mean the cache was set up without one
  if (!token) {
    throw new Error('service-token cache returned no token')
  }

  return token
}

/**
 * Request headers identifying this service, for a call to forms-identity-api.
 * Built here so the header shape is defined once, next to the token it
 * carries; callers spread it into the generic fetch options.
 * @returns {Promise<Record<string, string>>}
 */
export async function serviceAuthHeaders() {
  return { Authorization: `Bearer ${await getServiceToken()}` }
}

/**
 * Owns the STS client and the token cache for their whole lifetime.
 *
 * The cache is in memory rather than the shared session cache: a bearer
 * credential stays inside the process, and a Redis outage cannot stop this
 * service calling the API.
 * @satisfies {ServerRegisterPluginObject<void>}
 */
export const serviceToken = {
  plugin: {
    name: 'service-token',
    register(server) {
      // The Node AWS SDK has no proxy support of its own, so the agent is
      // supplied through its request handler. ProxyAgent goes direct when no
      // proxy variables are set, which is the local and test case.
      const sts = new STSClient({
        requestHandler: new NodeHttpHandler({
          httpAgent: new ProxyAgent(),
          httpsAgent: new ProxyAgent()
        })
      })

      tokenCache = server.cache({
        cache: CACHE_SEGMENT,
        segment: CACHE_SEGMENT,
        // A fallback for catbox's own internal ttl() computations; mintToken
        // sets the ttl actually used on every generated value via flags.ttl.
        expiresIn:
          config.get('identityApi.tokenDurationSeconds') *
          1000 *
          TTL_SAFETY_MARGIN,
        generateTimeout: 5000,
        generateFunc: (id, flags) => mintToken(sts, flags)
      })

      server.events.on('stop', () => {
        sts.destroy()
      })
    }
  }
}

/**
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 * @import { GenerateFuncFlags, Policy, PolicyOptions } from '@hapi/catbox'
 */
