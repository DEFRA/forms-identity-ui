import { REGISTERED_CLIENT_IDS } from '~/src/server/oidc/provider-config.js'

/**
 * Finds the client that sent the user to the account pages, and checks the
 * return address against that client. The return address is shown as a link
 * and carried through a sign in, so it is accepted only on an origin where
 * the client has a registered redirect URI.
 * @param {Provider} provider
 * @param {{ clientId?: unknown, returnUrl?: unknown }} sent - the values the request or the session holds
 * @returns {Promise<ClientReturn | undefined>} undefined when no registered client is named
 */
export async function findClientReturn(provider, { clientId, returnUrl }) {
  if (typeof clientId !== 'string' || !REGISTERED_CLIENT_IDS.has(clientId)) {
    return undefined
  }

  const client = await provider.Client.find(clientId)

  if (!client) {
    return undefined
  }

  const origins = new Set(
    (client.redirectUris ?? []).map((uri) => new URL(uri).origin)
  )
  const returnOrigin =
    typeof returnUrl === 'string' ? URL.parse(returnUrl)?.origin : undefined

  return {
    clientId,
    initiateLoginUri: client.initiateLoginUri,
    returnUrl:
      returnOrigin && origins.has(returnOrigin)
        ? /** @type {string} */ (returnUrl)
        : undefined
  }
}

/**
 * @typedef {object} ClientReturn
 * @property {string} clientId - the registered client
 * @property {string} [initiateLoginUri] - where that client starts a sign in
 * @property {string} [returnUrl] - the return address, present only when it is on one of the client's origins
 */

/**
 * @import Provider from 'oidc-provider'
 */
