import { randomUUID } from 'node:crypto'

import Joi from 'joi'

import { config } from '~/src/config/index.js'
import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { getBackLink } from '~/src/server/common/helpers/navigation.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { signinFormCsp } from '~/src/server/plugins/blankie.js'
import { getAccountGated } from '~/src/server/routes/account.js'
import {
  formPayload,
  requireInteraction
} from '~/src/server/routes/interactions/signin.js'
import * as accountService from '~/src/server/services/account-service.js'
import {
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  VALID
} from '~/src/server/services/outcomes.js'

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

/** The pre entry every /interaction route must carry */
const GATE = {
  method: requireInteraction,
  assign: /** @type {const} */ ('details')
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
 * @param {{ consumed: boolean, verified: boolean, target: string } | null } otp
 */
function otpVerified(otp) {
  return otp && !otp.consumed && otp.verified
}

/**
 * @param {{ consumed: boolean, verified: boolean, target: string } | null } otp
 */
function otpMissing(otp) {
  return !otp || otp.consumed
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
 *
 * The redirect is written straight to the raw response, and the handler
 * must return the `h.abandon` this resolves to — same reason
 * `interactionFinished`/`finishLogin` do it (see oidc.js and interaction.js):
 * if hapi's own response lifecycle ran afterwards, its transmit step calls
 * `res.setHeader('set-cookie', ...)` with only the cookies *it* tracked
 * (e.g. crumb), which replaces rather than appends to the header and
 * silently drops the interaction cookie set here.
 * @param {Request} request
 * @param {ResponseToolkit} h
 * @param {{ name: string, path: string }} prompt - e.g. `{ name: 'change-email', path: '/account' }`
 * @param {Session} session - the caller's own oidc-provider session, so the
 *   interaction is tied to the same accountId it was started under
 */
async function startAccountInteraction(request, h, { name, path }, session) {
  const provider = request.server.app.oidcProvider
  const { req, res } = request.raw
  const ctx = provider.createContext(req, res)
  const uid = randomUUID()
  // Scoped to every route of this interaction (change-email, send-code,
  // sent-code, ...), not just the return path — those are cookie-path
  // siblings, not descendants, so a path scoped to returnTo would only ever
  // be sent back on the first of them
  const cookiePath = `${path}/${uid}`
  const returnTo = `${cookiePath}/${name}`

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
    path: cookiePath,
    maxAge: INTERACTION_TTL * 1000
  })

  res.statusCode = 303
  res.setHeader('Location', returnTo)
  res.setHeader('Content-Length', '0')
  res.end()

  return h.abandon
}

export default /** @type {ServerRoute[]} */ (
  /** @type {unknown[]} */ ([
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: '/account/change-email',
      async handler(request, h) {
        const { session } = await getAccountGated(request)

        return startAccountInteraction(
          request,
          h,
          { name: 'change-email', path: '/account' },
          session
        )
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
      path: '/account/{uid}/change-email',
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
          { uid: details.uid, phone: account.phone, email: account.email },
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )

        return h.redirect(`/account/${details.uid}/phone-code`)
      }
    }),
    /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
    ({
      method: 'GET',
      path: '/account/{uid}/phone-code',
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
        const phoneOtp = await identityApi.getOtp(
          details.uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )

        // no code has been requested yet, so there is nothing to check and
        // no address to show: start the journey where it actually begins
        if (otpMissing(phoneOtp)) {
          return h.redirect(`/account/${details.uid}/change-email`)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        return h.view('account/phone-code-sent', {
          uid: details.uid,
          phoneEndDigits,
          showResendNotification,
          backLink: { href: `/account/{${details.uid}}/change-email` }
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string }, Pres: InteractionPres }>} */
    ({
      method: 'POST',
      path: '/account/{uid}/phone-code',
      options: {
        validate: { params: uidParams, payload: formPayload('code') },
        plugins: { blankie: signinFormCsp },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        const { account } = await getAccountGated(request)
        const { code } = request.payload
        const result = await accountService.submitPhoneCode(details.uid, code)

        if (result.outcome === VALID) {
          return h.redirect(`/account/${details.uid}/enter-email`)
        }
        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect(`/account/${details.uid}/code/expired`)
        }

        return h.view('account/change-email', {
          uid: details.uid,
          backLink: getBackLink(request.yar),
          phoneEndDigits: getPhoneEndDigits(account.phone)
        })
      }
    }),
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
    /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
    ({
      method: 'GET',
      path: '/account/{uid}/enter-email',
      options: {
        validate: { params: uidParams },
        plugins: { blankie: signinFormCsp },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          details.uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (!otpVerified(phoneOtp)) {
          return h.redirect(`/account/${details.uid}/change-email`)
        }

        return h.view('account/new-email', { uid: request.pre.details.uid })
      }
    }),
    /** @satisfies {ServerRoute<{ Pres: InteractionPres, Query: { resend?: boolean}, Payload: { email: string } }>} */
    ({
      method: 'POST',
      path: '/account/{uid}/new-email',
      options: {
        validate: {
          params: uidParams,
          payload: Joi.object({
            crumb: Joi.string().optional(),
            email: Joi.string().email().optional()
          })
        },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        const { account } = await getAccountGated(request)

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          details.uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (!otpVerified(phoneOtp)) {
          return h.redirect(`/account/${details.uid}/change-email`)
        }

        await identityApi.requestOtpViaEmail(
          {
            uid: details.uid,
            targetEmail: request.payload.email,
            accountEmail: account.email
          },
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_EMAIL
        )

        return h.redirect(`/account/${details.uid}/email-code`)
      }
    }),
    /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
    ({
      method: 'GET',
      path: '/account/{uid}/email-code',
      options: {
        validate: { params: uidParams },
        plugins: { blankie: signinFormCsp },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        await getAccountGated(request)

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          details.uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )

        if (!otpVerified(phoneOtp)) {
          return h.redirect(`/account/${details.uid}/change-email`)
        }

        // Verify there is an OTP record for this interaction
        // i.e. a code has been requested
        const emailOtp = await identityApi.getOtp(
          details.uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_EMAIL
        )

        // no code has been requested yet, so there is nothing to check and
        // no address to show: start the journey where it actually begins
        if (otpMissing(emailOtp)) {
          return h.redirect(`/account/${details.uid}/change-email`)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        return h.view('account/email-code-sent', {
          uid: details.uid,
          email: emailOtp?.target,
          showResendNotification,
          backLink: { href: `/account/{${details.uid}}/change-email` }
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string }, Pres: InteractionPres }>} */
    ({
      method: 'POST',
      path: '/account/{uid}/email-code',
      options: {
        validate: { params: uidParams, payload: formPayload('code') },
        plugins: { blankie: signinFormCsp },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        const { account } = await getAccountGated(request)
        const { code } = request.payload

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          details.uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )

        // no code has been verified
        if (!otpVerified(phoneOtp)) {
          return h.redirect(`/account/${details.uid}/change-email`)
        }

        const result = await accountService.submitEmailCode(details.uid, code)

        if (result.outcome === VALID) {
          const emailOtp = await identityApi.getOtp(
            details.uid,
            await getServiceToken(),
            PURPOSE.ACCOUNT_VERIFY_EMAIL
          )
          // Update the email address in the account. This will also consume the email OTP
          await accountService.changeEmailAddress(
            details.uid,
            account.id,
            /** @type {string} */ (emailOtp?.target)
          )
          // Consume any remainging OTPs (such as the phone OTP)
          await identityApi.cleanupOtps(details.uid, await getServiceToken())
          return h.redirect('/account')
        }
        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect(`/account/${details.uid}/code/expired`)
        }

        return h.view('account/change-email', {
          uid: details.uid,
          backLink: getBackLink(request.yar),
          phoneEndDigits: getPhoneEndDigits(account.phone)
        })
      }
    })
  ])
)

/**
 * @import { Request, ResponseToolkit, ServerRoute } from '@hapi/hapi'
 * @import { Interaction, Session } from 'oidc-provider'
 * @import { InteractionPres } from '~/src/server/routes/interactions/signin.js'
 */
