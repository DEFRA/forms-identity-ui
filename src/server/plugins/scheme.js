import Boom from '@hapi/boom'

import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { getAccount } from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'

export const CITIZEN_SESSION = 'citizen-session'

/**
 * Turns a signed-in session into request credentials. It only reads, so it
 * is safe as the server-wide default: one session read per request.
 */
export function citizenSessionScheme() {
  return {
    /**
     * @param {Request} request
     * @param {ResponseToolkit} h
     */
    async authenticate(request, h) {
      const provider = request.server.app.oidcProvider
      const ctx = provider.createContext(request.raw.req, request.raw.res)
      const session = await provider.Session.get(ctx)

      if (!session.accountId) {
        return h.unauthenticated(Boom.unauthorized(null, CITIZEN_SESSION))
      }

      // Recorded apart from the credentials, which the refusals below also
      // leave empty. A new sign in gives a request with no session what it
      // lacks; these have a session already, so a new sign in would bring
      // the user back to the same refusal.
      request.app.hasCitizenSession = true

      const account = await getAccount(
        session.accountId,
        await getServiceToken()
      )

      if (!account) {
        return h.unauthenticated(Boom.unauthorized(null, CITIZEN_SESSION))
      }

      if (!account.phone) {
        logger.error(`Missing phone number for account ${session.accountId}`)
        return h.unauthenticated(Boom.unauthorized(null, CITIZEN_SESSION))
      }

      return h.authenticated({ credentials: account })
    }
  }
}

/**
 * @import { Request, ResponseToolkit } from '@hapi/hapi'
 */
