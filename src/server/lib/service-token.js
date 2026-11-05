import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { ProxyAgent } from 'proxy-agent'

import { config } from '~/src/config/index.js'
import { bearerHeaders } from '~/src/server/common/helpers/fetch.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'

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

// The shortest token duration that STS accepts.
const MIN_TOKEN_DURATION_SECONDS = 60

// The token duration to request when the STS session allows it, and the time
// that a token must leave before the end of the session.
const TOKEN_DURATION_SECONDS = config.get('identityApi.tokenDurationSeconds')
const TOKEN_DURATION_BUFFER_SECONDS = config.get(
  'identityApi.tokenDurationBufferSeconds'
)

/**
 * Whole seconds from now until the given time
 * @param {Date} time
 * @returns {number}
 */
function secondsUntil(time) {
  return Math.floor((time.getTime() - Date.now()) / 1000)
}

/**
 * Gets the expiry of the STS session that signs the token request.
 *
 * The SDK keeps the container credentials in memory. If they last long enough
 * for the token and the buffer, their expiry is used and there is no network
 * call. If not, the SDK reads the credentials again (`forceRefresh`), because
 * the container credentials endpoint can already serve a new session. The SDK
 * signs the token request with the credentials it holds after this call, so the
 * expiry agrees with the session that signs the token.
 *
 * If the forced read fails, the SDK keeps the credentials it already holds and
 * signs with them. Thus their expiry still applies, and a failure of the
 * credentials endpoint does not stop the token request.
 * @param {STSClient} sts
 * @param {number} neededSeconds - the session time that the configured token needs
 * @returns {Promise<Date | undefined>} undefined for credentials that do not expire
 */
async function signingSessionExpiry(sts, neededSeconds) {
  const held = await sts.config.credentials()

  if (!held.expiration || secondsUntil(held.expiration) > neededSeconds) {
    return held.expiration
  }

  try {
    const refreshed = await sts.config.credentials({ forceRefresh: true })
    return refreshed.expiration
  } catch (err) {
    logger.warn(
      err,
      `[serviceTokenCredentials] Could not read new STS credentials, so the token request uses the current session, which ends in ${secondsUntil(held.expiration)}s`
    )
    return held.expiration
  }
}

/**
 * Gets the token duration to request from STS.
 *
 * STS issues a token only if the token expires before the STS session that
 * signs it. Thus the duration is the configured value or the time left in the
 * session, minus a buffer, whichever is shorter.
 *
 * The duration is never less than the STS minimum, because STS always rejects
 * a shorter duration. If the session has less time left than the minimum, no
 * duration is valid and STS rejects the request. The next request succeeds
 * when the credentials endpoint serves a new session.
 *
 * Static local credentials have no expiry, so the configured duration applies.
 * @param {STSClient} sts
 * @returns {Promise<{ durationSeconds: number, sessionSecondsLeft?: number }>}
 */
async function tokenDuration(sts) {
  const expiration = await signingSessionExpiry(
    sts,
    TOKEN_DURATION_SECONDS + TOKEN_DURATION_BUFFER_SECONDS
  )

  if (!expiration) {
    return { durationSeconds: TOKEN_DURATION_SECONDS }
  }

  const sessionSecondsLeft = secondsUntil(expiration)

  const durationSeconds = Math.max(
    MIN_TOKEN_DURATION_SECONDS,
    Math.min(
      TOKEN_DURATION_SECONDS,
      sessionSecondsLeft - TOKEN_DURATION_BUFFER_SECONDS
    )
  )

  if (durationSeconds > sessionSecondsLeft) {
    logger.warn(
      `[serviceTokenDuration] The STS session ends in ${sessionSecondsLeft}s, which is less than the minimum token duration of ${MIN_TOKEN_DURATION_SECONDS}s, so STS rejects the token request`
    )
  } else if (durationSeconds < TOKEN_DURATION_SECONDS) {
    logger.info(
      `[serviceTokenDuration] Requesting a ${durationSeconds}s token because the STS session ends in ${sessionSecondsLeft}s`
    )
  }

  return { durationSeconds, sessionSecondsLeft }
}

/**
 * Gets a token that identifies this service to forms-identity-api. It also
 * gives the token duration, so that the cache removes the token before STS
 * expires it.
 *
 * The subject is set by STS from the container's own credentials, so the
 * receiving service can tell who called rather than only that the caller knew
 * a shared secret.
 * @param {STSClient} sts
 * @returns {Promise<{ token: string, durationSeconds: number }>}
 */
async function retrieveToken(sts) {
  const { durationSeconds, sessionSecondsLeft } = await tokenDuration(sts)

  /** @type {GetWebIdentityTokenCommandOutput} */
  let response
  try {
    response = await sts.send(
      new GetWebIdentityTokenCommand({
        SigningAlgorithm: 'RS256',
        Audience: [config.get('identityApi.audience')],
        DurationSeconds: durationSeconds
      })
    )
  } catch (err) {
    const sessionText =
      sessionSecondsLeft === undefined
        ? 'credentials with no expiry'
        : `a session that ends in ${sessionSecondsLeft}s`
    logger.error(
      err,
      `[serviceTokenRequest] STS did not issue a ${durationSeconds}s token signed by ${sessionText}`
    )
    throw err
  }

  const { WebIdentityToken } = response

  if (!WebIdentityToken) {
    throw new Error('STS returned no web identity token')
  }

  return { token: WebIdentityToken, durationSeconds }
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
        // A fallback only: generateFunc sets the TTL of each token.
        expiresIn: TOKEN_DURATION_SECONDS * 1000 - TTL_SAFETY_BUFFER_MS,
        generateTimeout: 5000,
        // Near the end of the STS session, the token duration can be shorter
        // than the configured value. Thus the cache uses the duration of each
        // token. A TTL of zero keeps the token out of the cache, so the next
        // call gets a new token.
        generateFunc: async (_id, flags) => {
          const { token, durationSeconds } = await retrieveToken(sts)
          flags.ttl = Math.max(durationSeconds * 1000 - TTL_SAFETY_BUFFER_MS, 0)
          return token
        }
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
 * @import { GetWebIdentityTokenCommandOutput } from '@aws-sdk/client-sts'
 */
