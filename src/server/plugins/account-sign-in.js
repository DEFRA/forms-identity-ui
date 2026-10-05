import { StatusCodes } from 'http-status-codes'

import { config } from '~/src/config/index.js'
import {
  SESSION_KEY_BACK_LINK,
  SESSION_KEY_CLIENT_ID
} from '~/src/server/common/constants/session-names.js'
import { findClientReturn } from '~/src/server/services/client-return.js'

const OIDC_ISSUER = config.get('oidc.issuer')

const ACCOUNT_PATH = '/account'

/**
 * @param {string} path
 */
function isAccountPath(path) {
  return path === ACCOUNT_PATH || path.startsWith(`${ACCOUNT_PATH}/`)
}

/**
 * The page the client sends the user to when its sign in is complete. It is
 * always the account page, with the client named, because that is the page a
 * client sends its users to.
 * @param {ClientReturn} clientReturn
 */
function targetLinkUri({ clientId, returnUrl }) {
  const target = new URL(ACCOUNT_PATH, OIDC_ISSUER)
  target.searchParams.set('client_id', clientId)

  if (returnUrl) {
    target.searchParams.set('returnUrl', returnUrl)
  }

  return target.href
}

/**
 * Sends a user who has no session to the client they came from, so that the
 * client starts its sign in (OpenID Connect Core, section 4, "Initiating
 * Login from a Third Party"). The client's sign in makes the provider
 * session, and the client then sends the user to `target_link_uri`.
 *
 * The provider session stays the only thing that opens the account pages.
 * @satisfies {ServerRegisterPluginObject<void>}
 */
export default {
  plugin: {
    name: 'account-sign-in',
    /**
     * @param {Server} server
     */
    register(server) {
      server.ext(
        'onPreResponse',
        /**
         * @param {Request} request
         * @param {ResponseToolkit} h
         */
        async (request, h) => {
          const { response } = request

          if (
            !request.app.hasNoCitizenSession ||
            !isAccountPath(request.path) ||
            !('isBoom' in response) ||
            response.output.statusCode !== StatusCodes.UNAUTHORIZED.valueOf()
          ) {
            return h.continue
          }

          // Authentication runs before validation, so the query is as the
          // user sent it. A client names itself when it sends a user to the
          // account page. The session holds that name for the steps of a
          // journey, which have no query.
          const clientReturn = await findClientReturn(
            request.server.app.oidcProvider,
            {
              clientId:
                request.query.client_id ??
                request.yar.get(SESSION_KEY_CLIENT_ID),
              returnUrl:
                request.query.returnUrl ??
                request.yar.get(SESSION_KEY_BACK_LINK)
            }
          )

          // With no client to send the user to, the page tells them to
          // sign in again from the service they came from
          if (!clientReturn?.initiateLoginUri) {
            return h
              .view('account/sign-in-again')
              .code(StatusCodes.UNAUTHORIZED)
          }

          const signIn = new URL(clientReturn.initiateLoginUri)
          signIn.searchParams.set('iss', OIDC_ISSUER)
          signIn.searchParams.set(
            'target_link_uri',
            targetLinkUri(clientReturn)
          )

          return h.redirect(signIn.href)
        }
      )
    }
  }
}

/**
 * @import { Request, ResponseToolkit, Server, ServerRegisterPluginObject } from '@hapi/hapi'
 * @import { ClientReturn } from '~/src/server/services/client-return.js'
 */
