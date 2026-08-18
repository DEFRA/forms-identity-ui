import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { ProxyAgent } from 'proxy-agent'

import { config } from '~/src/config/index.js'

const CACHE_SEGMENT = 'service-token'
const CACHE_KEY = 'identity-api'

/**
 * Set when the plugin registers. The OIDC adapter is constructed by
 * `oidc-provider` with no request in scope, so the policy is reached from
 * module scope rather than threaded through the lib layer.
 * @type {Policy<string, PolicyOptions<string>> | undefined}
 */
let tokenCache

/**
 * Mints a token identifying this service to forms-identity-api.
 *
 * The subject is stamped by STS from the container's own credentials, so the
 * receiving service can tell who called rather than only that the caller knew
 * a shared secret.
 * @param {STSClient} sts
 * @returns {Promise<string>}
 */
async function mintToken(sts) {
  const { WebIdentityToken } = await sts.send(
    new GetWebIdentityTokenCommand({
      SigningAlgorithm: 'RS256',
      Audience: [config.get('identityApi.audience')],
      DurationSeconds: config.get('identityApi.tokenDurationSeconds')
    })
  )

  if (!WebIdentityToken) {
    throw new Error('STS returned no web identity token')
  }

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

  // A configured generateFunc always yields a value or throws, so a null
  // here would mean the cache was mis-provisioned without one
  if (!token) {
    throw new Error('service-token cache returned no token')
  }

  return token
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

      const durationMs = config.get('identityApi.tokenDurationSeconds') * 1000

      tokenCache = server.cache({
        cache: CACHE_SEGMENT,
        segment: CACHE_SEGMENT,
        // Retire the cached token before STS expires it, so a request never
        // carries one that dies in flight
        expiresIn: durationMs * 0.8,
        generateTimeout: 5000,
        generateFunc: () => mintToken(sts)
      })

      server.events.on('stop', () => {
        sts.destroy()
      })
    }
  }
}

/**
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 * @import { Policy, PolicyOptions } from '@hapi/catbox'
 */
