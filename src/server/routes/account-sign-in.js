import Boom from '@hapi/boom'
import { StatusCodes } from 'http-status-codes'

import { config } from '~/src/config/index.js'
import { CITIZEN_SESSION } from '~/src/server/plugins/scheme.js'
import { findSentOrStoredClientReturn } from '~/src/server/services/client-return.js'

const OIDC_ISSUER = config.get('oidc.issuer')

const ACCOUNT_PATH = '/account'

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
 * @param {Request} request
 * @param {ResponseToolkit} h
 */
async function signInAtClient(request, h) {
  const { response } = request

  // The other refusals have a session already, so a new sign in would bring
  // the user back to the same refusal
  if (
    request.app.hasCitizenSession ||
    !Boom.isBoom(response, StatusCodes.UNAUTHORIZED)
  ) {
    return h.continue
  }

  // Authentication runs before validation, so the query is as the user sent
  // it
  const clientReturn = await findSentOrStoredClientReturn(
    request.server.app.oidcProvider,
    request.query,
    request.yar
  )

  // With no client to send the user to, the page tells them to sign in
  // again from the service they came from
  if (!clientReturn?.initiateLoginUri) {
    return h.view('account/sign-in-again').code(StatusCodes.UNAUTHORIZED)
  }

  const signIn = new URL(clientReturn.initiateLoginUri)
  signIn.searchParams.set('iss', OIDC_ISSUER)
  signIn.searchParams.set('target_link_uri', targetLinkUri(clientReturn))

  return h.redirect(signIn.href)
}

/**
 * Route options for a page that only a signed-in user opens. The redirect
 * runs on the route's own response, ahead of the error pages, so that it
 * sees the refusal as authentication made it.
 */
export const signedInOnly = /** @satisfies {RouteOptions} */ ({
  auth: { mode: 'required', strategy: CITIZEN_SESSION },
  ext: {
    onPreResponse: {
      method: signInAtClient,
      options: { before: 'error-pages' }
    }
  }
})

/**
 * @import { Request, ResponseToolkit, RouteOptions } from '@hapi/hapi'
 * @import { ClientReturn } from '~/src/server/services/client-return.js'
 */
