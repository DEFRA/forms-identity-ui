import Boom from '@hapi/boom'
import Joi from 'joi'

import { SESSION_KEY_BACK_LINK } from '~/src/server/common/constants/session-names.js'
import { getBackLink } from '~/src/server/common/helpers/navigation.js'
import { getAccount } from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'

/**
 * @typedef {object} AccountWithPhone
 * @property {string} id -account id
 * @property {string} email - email address
 * @property {string} phone - phone number
 */

const queryParamsSchema = Joi.object({
  returnUrl: Joi.string()
})

/* eslint-disable jsdoc/reject-any-type -- hapi request refs are invariant, so only any-ref helpers can be shared by payload-narrowed routes */

/**
 * Validates the user is logged in and has an account.
 * If not logged in, or no account exists for the user, throws an error.
 * If the account exists, returns the account and their oidc-provider session.
 * @param {Request<any>} request
 * @returns {Promise<{ session: Session, account: AccountWithPhone }>}
 */
export async function getAccountGated(request) {
  const provider = request.server.app.oidcProvider
  const ctx = provider.createContext(request.raw.req, request.raw.res)
  const session = await provider.Session.get(ctx)

  if (!session.accountId) {
    throw Boom.unauthorized()
  }

  const account = await getAccount(session.accountId, await getServiceToken())

  if (!account) {
    throw Boom.unauthorized()
  }

  if (!account.phone) {
    throw Boom.badRequest('Missing phone number')
  }

  const accountTyped = /** @type {AccountWithPhone} */ (account)
  return { account: accountTyped, session }
}

export default /** @type {ServerRoute} */
({
  method: 'GET',
  path: '/account',
  async handler(request, h) {
    const { account } = await getAccountGated(request)

    const { query, yar } = request

    if (query.returnUrl) {
      yar.set(SESSION_KEY_BACK_LINK, query.returnUrl)
    }

    const backLink = getBackLink(yar)

    return h.view('account/account', {
      account,
      backLink,
      changeEmailLink: '/account/change-email',
      changePhoneLink: '/account/change-phone'
    })
  },
  options: { validate: { query: queryParamsSchema } }
})

/**
 * @import { Request, ServerRoute } from '@hapi/hapi'
 * @import { Session } from 'oidc-provider'
 */
