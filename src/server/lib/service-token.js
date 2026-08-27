import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { ProxyAgent } from 'proxy-agent'

import { config } from '~/src/config/index.js'
import { bearerHeaders } from '~/src/server/common/helpers/fetch.js'

const CACHE_SEGMENT = 'service-token'
const CACHE_KEY = 'identity-api'

// Retire a cached token one minute before STS expires it, so a request in
// flight still holds a valid token.
const TTL_SAFETY_BUFFER_MS = 60_000

/**
 * Set when the plugin registers. The OIDC adapter is constructed by
 * `oidc-provider` with no request in scope, so the adapter reads the
 * policy from module scope.
 * @type {Policy<string, PolicyOptions<string>> | undefined}
 */
let tokenCache

/**
 * Retrieves a token identifying this service to forms-identity-api.
 *
 * The subject is set by STS from the container's own credentials, so the
 * receiving service can tell who called rather than only that the caller knew
 * a shared secret.
 * @param {STSClient} sts
 * @returns {Promise<string>}
 */
async function retrieveToken(sts) {
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
 * The current caller token, retrieved on demand and reused until it nears expiry
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
 * Request headers identifying this service, for a call to forms-identity-api;
 * callers spread it into the generic fetch options.
 * @returns {Promise<Record<string, string>>}
 */
export async function serviceAuthHeaders() {
  return bearerHeaders(await getServiceToken())
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
        expiresIn:
          config.get('identityApi.tokenDurationSeconds') * 1000 -
          TTL_SAFETY_BUFFER_MS,
        generateTimeout: 5000,
        generateFunc: () => retrieveToken(sts)
      })

      // 'stop' is hapi's documented server event, emitted once the server
      // has stopped. destroy() is the SDK's own teardown: it closes the
      // client's keep-alive sockets, so the process can exit rather than
      // wait on idle agents.
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
