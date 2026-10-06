import Boom from '@hapi/boom'
import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { getBackLink } from '~/src/server/common/helpers/navigation.js'
import { setLanguage } from '~/src/server/i18n/index.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { CITIZEN_SESSION } from '~/src/server/plugins/scheme.js'
import { formPayload } from '~/src/server/routes/interaction.js'
import * as accountService from '~/src/server/services/account-service.js'
import {
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  VALID
} from '~/src/server/services/outcomes.js'

const SESSION_KEY_BACK_LINK = 'session-back-link'

// Views
const JOURNEY_START_VIEW = 'account/change-email'

// Paths - account
const ACCOUNT_PATH = '/account'

// Paths - change email
const EMAIL_JOURNEY_START_PATH = '/account/change-email'
const EMAIL_JOURNEY_SEND_CODE = '/account/send-code'
const EMAIL_JOURNEY_PHONE_SENT_CODE = '/account/phone-sent-code'
const EMAIL_JOURNEY_PHONE_CODE = '/account/phone-code'
const EMAIL_JOURNEY_ENTER_EMAIL = '/account/enter-email'
const EMAIL_JOURNEY_EMAIL_CODE = '/account/email-code'

// Paths - change phone number
const PHONE_JOURNEY_START_PATH = '/account/change-phone'

const queryParamsSchema = Joi.object({
  returnUrl: Joi.string(),
  language: Joi.string().valid('en-GB', 'cy')
})

const emailSchema = Joi.string().email().required()

/* eslint-disable jsdoc/reject-any-type -- hapi request refs are invariant, so only any-ref helpers can be shared by payload-narrowed routes */

/**
 * Get the session UID (preventing it from being in a URL route param)
 * so that back-end records from a different user cannot be interposed.
 * @param {Request<any>} request
 */
export function getSessionUid(request) {
  const uid = request.auth.artifacts.sessionUid
  if (!uid) {
    throw Boom.badRequest()
  }
  return /** @type {string} */ (uid)
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
 * Ensure any language parameters are actioned, so the user can switch languages on any page.
 * @param {Request<any>} request
 * @param {ResponseToolkit<any>} h
 */
export function preHandlerMethod(request, h) {
  setLanguage(request)
  return h.response()
}

/** The pre entry every /interaction route must carry */
const preHandler = {
  method: preHandlerMethod
}

export default /** @type {ServerRoute[]} */ (
  /** @type {unknown[]} */ ([
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: ACCOUNT_PATH,
      options: {
        validate: { query: queryParamsSchema },
        auth: { mode: 'required', strategy: CITIZEN_SESSION },
        pre: [preHandler]
      },
      handler(request, h) {
        const account = request.auth.credentials

        const { query, yar } = request

        if (query.returnUrl) {
          yar.set(SESSION_KEY_BACK_LINK, query.returnUrl)
        }

        const backLink = yar.get(SESSION_KEY_BACK_LINK)
          ? { href: yar.get(SESSION_KEY_BACK_LINK) }
          : undefined

        const notificationSuccessKey = request.yar
          .flash(sessionNames.accountSuccessNotification)
          .at(0)

        return h.view('account/account', {
          account,
          backLink,
          changeEmailLink: EMAIL_JOURNEY_START_PATH,
          changePhoneLink: PHONE_JOURNEY_START_PATH,
          notificationSuccessKey
        })
      }
    }),
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_START_PATH,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION },
        pre: [preHandler]
      },
      handler(request, h) {
        // Check we have a session
        getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        const phoneEndDigits = getPhoneEndDigits(account.phone)

        const backLink = {
          href: ACCOUNT_PATH
        }

        return h.view(JOURNEY_START_VIEW, {
          backLink,
          phoneEndDigits
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { resend?: boolean} }>} */
    ({
      method: 'POST',
      path: EMAIL_JOURNEY_SEND_CODE,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        await identityApi.requestOtpViaSms(
          {
            uid,
            accountId: account.id,
            purpose: PURPOSE.ACCOUNT_VERIFY_PHONE
          },
          await getServiceToken()
        )

        return h.redirect(EMAIL_JOURNEY_PHONE_SENT_CODE)
      }
    }),
    /** @satisfies {ServerRoute} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_PHONE_SENT_CODE,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION },
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        const phoneEndDigits = getPhoneEndDigits(account.phone)

        // Verify there is an OTP record for this interaction
        // i.e. a code has been requested
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (otpMissing(phoneOtp)) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        return h.view('account/phone-code-sent', {
          phoneEndDigits,
          showResendNotification
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: EMAIL_JOURNEY_PHONE_CODE,
      options: {
        validate: { payload: formPayload('code') },
        auth: { mode: 'required', strategy: CITIZEN_SESSION }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { code } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)
        const result = await accountService.submitPhoneCode(
          uid,
          code,
          account.id
        )

        if (result.outcome === VALID) {
          return h.redirect(EMAIL_JOURNEY_ENTER_EMAIL)
        }

        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect('/account/code/expired')
        }

        return h.view(JOURNEY_START_VIEW, {
          backLink: getBackLink(request.yar),
          phoneEndDigits: getPhoneEndDigits(account.phone)
        })
      }
    }),
    /** @satisfies {ServerRoute} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_ENTER_EMAIL,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION },
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (!otpVerified(phoneOtp)) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        return h.view('account/new-email')
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { resend?: boolean}, Payload: { email: string } }>} */
    ({
      method: 'POST',
      path: EMAIL_JOURNEY_ENTER_EMAIL,
      options: {
        validate: {
          payload: Joi.object({
            crumb: Joi.string().optional(),
            email: Joi.string().allow('')
          })
        },
        auth: { mode: 'required', strategy: CITIZEN_SESSION }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { email } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        const trimmed = email.trim()
        const { error } = emailSchema.validate(trimmed)

        if (error) {
          return h.view('account/new-email', {
            email,
            errorKey: trimmed
              ? 'account.newEmail.errorFormat'
              : 'account.newEmail.errorRequired'
          })
        }

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (!otpVerified(phoneOtp)) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        await identityApi.requestOtpViaEmail(
          {
            uid,
            email,
            accountId: account.id,
            purpose: PURPOSE.ACCOUNT_VERIFY_EMAIL
          },
          await getServiceToken()
        )

        return h.redirect(EMAIL_JOURNEY_EMAIL_CODE)
      }
    }),
    /** @satisfies {ServerRoute} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_EMAIL_CODE,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION },
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )

        if (!otpVerified(phoneOtp)) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        // Verify there is an OTP record for this interaction
        // i.e. a code has been requested
        const emailOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_EMAIL
        )
        if (otpMissing(emailOtp)) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        return h.view('account/email-code-sent', {
          email: emailOtp?.target,
          showResendNotification
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: EMAIL_JOURNEY_EMAIL_CODE,
      options: {
        validate: { payload: formPayload('code') },
        auth: { mode: 'required', strategy: CITIZEN_SESSION }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { code } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (!otpVerified(phoneOtp)) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        const result = await accountService.submitEmailCode(
          uid,
          code,
          account.id
        )

        if (result.outcome === VALID) {
          // Update the email address in the account. This will also consume the email OTP
          await accountService.changeEmailAddress(uid, account.id)

          // Notification
          request.yar.flash(
            sessionNames.accountSuccessNotification,
            'account.successChangedEmailNotificationText'
          )

          return h.redirect(ACCOUNT_PATH)
        }

        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect('/account/code/expired')
        }

        return h.view(JOURNEY_START_VIEW, {
          backLink: getBackLink(request.yar),
          phoneEndDigits: getPhoneEndDigits(account.phone)
        })
      }
    })
  ])
)

/**
 * @import { Request, ResponseToolkit, ServerRoute } from '@hapi/hapi'
 * @import { Account } from '~/src/server/types.js'
 */
