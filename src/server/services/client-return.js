import {
  SESSION_KEY_BACK_LINK,
  SESSION_KEY_CLIENT_ID
} from '~/src/server/common/constants/session-names.js'
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
 * Finds the client that sent the user, for a request that can be a step in a
 * journey. A client names itself in the query when it sends a user to the
 * account page. The steps of a journey have no query, so they use the client
 * stored from that visit.
 * @param {Provider} provider
 * @param {{ client_id?: unknown, returnUrl?: unknown }} query
 * @param {Yar} yar
 */
export function findSentOrStoredClientReturn(provider, query, yar) {
  return findClientReturn(provider, {
    clientId: query.client_id ?? yar.get(SESSION_KEY_CLIENT_ID),
    returnUrl: query.returnUrl ?? yar.get(SESSION_KEY_BACK_LINK)
  })
}

/**
 * Stores the client and its Back link for the steps of a journey. The Back
 * link belongs to that client, so with no return address the stored one is
 * cleared and the pages show no Back link.
 * @param {Yar} yar
 * @param {ClientReturn} clientReturn
 */
export function storeClientReturn(yar, { clientId, returnUrl }) {
  yar.set(SESSION_KEY_CLIENT_ID, clientId)

  if (returnUrl) {
    yar.set(SESSION_KEY_BACK_LINK, returnUrl)
  } else {
    yar.clear(SESSION_KEY_BACK_LINK)
  }
}

/**
 * @typedef {object} ClientReturn
 * @property {string} clientId - the registered client
 * @property {string} [initiateLoginUri] - where that client starts a sign in
 * @property {string} [returnUrl] - the return address, present only when it is on one of the client's origins
 */

/**
 * @import { Yar } from '@hapi/yar'
 * @import Provider from 'oidc-provider'
 */
