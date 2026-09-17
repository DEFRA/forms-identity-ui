import { randomUUID } from 'node:crypto'

import Boom from '@hapi/boom'
import Joi from 'joi'

import { config } from '~/src/config/index.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { getAccount } from '~/src/server/lib/identity-api.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { signinFormCsp } from '~/src/server/plugins/blankie.js'
import { requireInteraction } from '~/src/server/routes/interaction.js'
import * as signinService from '~/src/server/services/signin-service.js'

const SESSION_KEY_BACK_LINK = 'session-back-link'

/**
 * @typedef {object} AccountWithPhone
 * @property {string} id -account id
 * @property {string} email - email address
 * @property {string} phone - phone number
 */

// Same lifetime oidc-provider gives its own interactions, so an
// account-initiated one can't outlive (or outstay) a sign-in interaction
const INTERACTION_TTL = config.get('oidc.ttl.interaction')
const INTERACTION_COOKIE_OPTIONS = {
  secure: config.get('oidc.cookieSecure'),
  sameSite: /** @type {const} */ ('lax')
}

const uidParams = Joi.object({ uid: Joi.string().required() })

const queryParamsSchema = Joi.object({
  returnUrl: Joi.string()
})

/** The pre entry every /interaction route must carry */
const GATE = {
  method: requireInteraction,
  assign: /** @type {const} */ ('details')
}

/* eslint-disable jsdoc/reject-any-type -- hapi request refs are invariant, so only any-ref helpers can be shared by pre-narrowed routes */

/**
 * Validates the user is logged in and has an account.
 * If not logged in, or no account exists for the user, throws an error.
 * If the account exists, returns the account and their oidc-provider session.
 * @param {Request<any>} request
 * @returns {Promise<{ session: Session, account: AccountWithPhone }>}
 */
async function getAccountGated(request) {
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

/**
 * Gets last 4 digits of phone number
 * @param {string} phone
 * @returns {string}
 */
function getPhoneEndDigits(phone) {
  return phone.substring(phone.length - 4)
}

/**
 * Seeds a new oidc-provider Interaction for a flow that isn't driven by an
 * OIDC authorization request (the account pages, reached while already
 * signed in) - there is no `/auth` request for oidc-provider to attach one
 * to, so this mirrors what it does internally for a real sign-in prompt
 * (see oidc-provider's actions/authorization/interactions.js): mint a uid,
 * save an Interaction under it, then set the `_interaction` cookie so
 * `provider.interactionDetails`/`requireInteraction` can find it again on
 * the page it redirects to.
 * @param {Request<any>} request
 * @param {{ name: string, path: string }} prompt - e.g. `{ name: 'change-email', path: '/account/change-email' }`
 * @param {Session} session - the caller's own oidc-provider session, so the
 *   interaction is tied to the same accountId it was started under
 * @returns {Promise<string>} the path to redirect the caller to
 */
async function startAccountInteraction(request, { name, path }, session) {
  const provider = request.server.app.oidcProvider
  const ctx = provider.createContext(request.raw.req, request.raw.res)
  const uid = randomUUID()
  const returnTo = `${path}/${uid}/${name}`

  // @types/oidc-provider's Interaction has no declared constructor, so the
  // real one (jti, payload) — see oidc-provider's lib/models/interaction.js —
  // types as the implicit no-arg base constructor; cast around that gap
  const interaction = /** @type {Interaction} */ (
    new /** @type {new (jti: string, payload: object) => Interaction} */ (
      provider.Interaction
    )(uid, {
      returnTo,
      prompt: { name, reasons: [name], details: {} },
      params: {},
      session
    })
  )

  await interaction.save(INTERACTION_TTL)

  ctx.cookies.set(provider.cookieName('interaction'), uid, {
    ...INTERACTION_COOKIE_OPTIONS,
    path: returnTo,
    maxAge: INTERACTION_TTL * 1000
  })

  return returnTo
}

export default [
  /** @type {ServerRoute} */
  ({
    method: 'GET',
    path: '/account',
    async handler(request, h) {
      const { account } = await getAccountGated(request)

      const { query, yar } = request

      if (query.returnUrl) {
        yar.set(SESSION_KEY_BACK_LINK, query.returnUrl)
      }

      const backLink = yar.get(SESSION_KEY_BACK_LINK)
        ? { href: yar.get(SESSION_KEY_BACK_LINK) }
        : undefined

      return h.view('account/account', {
        account,
        backLink,
        changeEmailLink: '/account/change-email',
        changePhoneLink: '/account/change-phone'
      })
    },
    options: { validate: { query: queryParamsSchema } }
  }),
  /** @type {ServerRoute} */
  ({
    method: 'GET',
    path: '/account/change-email',
    async handler(request, h) {
      const { session } = await getAccountGated(request)

      const returnTo = await startAccountInteraction(
        request,
        { name: 'change-email', path: '/account' },
        session
      )

      return h.redirect(returnTo)
    }
  }),

  /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
  ({
    method: 'GET',
    path: '/account/{uid}/change-email',
    options: { validate: { params: uidParams }, pre: [GATE] },
    async handler(request, h) {
      const details = request.pre.details
      const { account } = await getAccountGated(request)
      const phoneEndDigits = getPhoneEndDigits(account.phone)
      const backLink = {
        href: '/account'
      }

      return h.view('account/change-email', {
        uid: details.uid,
        backLink,
        phoneEndDigits
      })
    }
  }),
  /** @satisfies {ServerRoute<{ Pres: InteractionPres, Query: { resend?: boolean} }>} */
  ({
    method: 'POST',
    path: '/account/{uid}/send-code',
    options: {
      validate: {
        params: uidParams
      },
      pre: [GATE]
    },
    async handler(request, h) {
      const details = request.pre.details
      const { account } = await getAccountGated(request)
      await identityApi.requestOtpViaSms(
        { uid: details.uid, phoneNumber: account.phone },
        await getServiceToken()
      )

      return h.redirect(`/account/${details.uid}/sent-code`)
    }
  }),
  /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
  ({
    method: 'GET',
    path: '/account/{uid}/sent-code',
    options: {
      validate: { params: uidParams },
      plugins: { blankie: signinFormCsp },
      pre: [GATE]
    },
    async handler(request, h) {
      const details = request.pre.details
      const { account } = await getAccountGated(request)
      const phoneEndDigits = getPhoneEndDigits(account.phone)

      // Verify there is an OTP record for this interaction
      // i.e. a code has been requested
      const email = await signinService.getSigninEmail(details.uid)

      // no code has been requested yet, so there is nothing to check and
      // no address to show: start the journey where it actually begins
      if (!email) {
        return h.redirect(`/account/${details.uid}/change-email`)
      }

      const showResendNotification = request.yar
        .flash(sessionNames.codeResendSuccessNotification)
        .at(0)

      return h.view('account/code-sent', {
        uid: details.uid,
        phoneEndDigits,
        showResendNotification
      })
    }
  })
  // /** @satisfies {ServerRoute<{ Payload: { code?: string }, Pres: InteractionPres }>} */
  // ({
  //   method: 'POST',
  //   path: '/interaction/{uid}/code',
  //   options: {
  //     validate: { params: uidParams, payload: formPayload('code') },
  //     plugins: { blankie: signinFormCsp },
  //     pre: [GATE]
  //   },
  //   async handler(request, h) {
  //     const details = request.pre.details
  //     const { code } = request.payload
  //     const result = await signinService.submitCode(details.uid, code)

  //     if (result.outcome === signinService.SIGNED_IN) {
  //       return finishLogin(request, h, result.accountId)
  //     }
  //     if (result.outcome === signinService.PHONE_REQUIRED) {
  //       return h.redirect(`/interaction/${details.uid}/phone`)
  //     }
  //     if (result.outcome === signinService.INVALID_CODE_CONSUMED_OR_EXPIRED) {
  //       return h.redirect(`/interaction/${details.uid}/code/expired`)
  //     }

  //     const email = await signinService.getSigninEmail(details.uid)

  //     // the record backing this page is gone (expired, or never requested),
  //     // so re-rendering would offer another attempt that cannot succeed
  //     if (!email) {
  //       return h.redirect(`/interaction/${details.uid}`)
  //     }

  //     return h.view('interaction/code', {
  //       uid: details.uid,
  //       email,
  //       errorKey: result.errorKey
  //     })
  //   }
  // }),
  // /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
  // ({
  //   method: 'GET',
  //   path: '/interaction/{uid}/code/expired',
  //   options: {
  //     validate: { params: uidParams },
  //     plugins: { blankie: signinFormCsp },
  //     pre: [GATE]
  //   },
  //   async handler(request, h) {
  //     return commonOTPHandler(request, h, 'code-expired')
  //   }
  // }),
  // /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
  // ({
  //   method: 'GET',
  //   path: '/interaction/{uid}/code/resend',
  //   options: {
  //     validate: { params: uidParams },
  //     plugins: { blankie: signinFormCsp },
  //     pre: [GATE]
  //   },
  //   async handler(request, h) {
  //     return commonOTPHandler(request, h, 'code-resend')
  //   }
  // })
]

/**
 * @import { Request, ServerRoute } from '@hapi/hapi'
 * @import { Interaction, Session } from 'oidc-provider'
 * @import { InteractionPres } from '~/src/server/routes/interaction.js'
 */
