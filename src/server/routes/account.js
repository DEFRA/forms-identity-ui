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
  EMAIL_ALREADY_IN_USE,
  EMAIL_SAME_AS_CURRENT,
  INVALID_CODE,
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  VALID
} from '~/src/server/services/outcomes.js'

const SESSION_KEY_BACK_LINK = 'session-back-link'
const SESSION_KEY_NEW_EMAIL = 'session-new-email'

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
const EMAIL_JOURNEY_CODE_RESEND = '/account/code/resend'
const EMAIL_JOURNEY_CHANGE_EMAIL_ERROR = '/account/change-email-error'

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
        const { query, yar } = request
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

        if (query.resend) {
          yar.flash(sessionNames.codeResendSuccessNotification, true)
        }

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

        if (
          result.outcome === INVALID_CODE ||
          result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED
        ) {
          return h.view('account/phone-code', {
            backLink: getBackLink(request.yar),
            phoneEndDigits: getPhoneEndDigits(account.phone),
            errorKey:
              'errorKey' in result
                ? result.errorKey
                : 'signin.code.errorInvalid',
            code: code ?? ''
          })
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

        return h.view('account/enter-email')
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
        const { query, yar } = request
        const uid = getSessionUid(request)
        const { email } = request.payload
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

        const trimmed = email.trim().toLowerCase()
        const { error } = emailSchema.validate(trimmed)
        let errorKey = ''
        if (error) {
          errorKey = trimmed
            ? 'account.newEmail.errorFormat'
            : 'account.newEmail.errorRequired'
        } else if (account.email === trimmed) {
          errorKey = 'account.newEmail.errorSameAsCurrent'
        }

        if (errorKey) {
          return h.view('account/enter-email', {
            email,
            errorKey
          })
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

        if (query.resend) {
          yar.flash(sessionNames.codeResendSuccessNotification, true)
        }

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

        // Save email in session in case the user needs a resend
        request.yar.set(SESSION_KEY_NEW_EMAIL, emailOtp?.target)

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
          const result = await accountService.changeEmailAddress(
            uid,
            account.id
          )

          // Failure in the API - display error page so user can follow link to re-enter email
          if (
            result.status === EMAIL_SAME_AS_CURRENT ||
            result.status === EMAIL_ALREADY_IN_USE
          ) {
            const errorKey =
              result.status === EMAIL_SAME_AS_CURRENT
                ? 'account.newEmail.errorSameAsCurrent'
                : 'account.newEmail.errorAlreadyTaken'
            request.yar.flash(sessionNames.changeEmailError, errorKey)
            return h.redirect(EMAIL_JOURNEY_CHANGE_EMAIL_ERROR)
          }

          // Notification
          request.yar.flash(
            sessionNames.accountSuccessNotification,
            'account.successChangedEmailNotificationText'
          )

          // Clear email from session
          request.yar.clear(SESSION_KEY_NEW_EMAIL)

          return h.redirect(ACCOUNT_PATH)
        }

        if (
          result.outcome === INVALID_CODE ||
          result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED
        ) {
          const emailOtp = await identityApi.getOtp(
            uid,
            await getServiceToken(),
            PURPOSE.ACCOUNT_VERIFY_EMAIL
          )
          return h.view('account/email-code', {
            uid,
            errorKey:
              'errorKey' in result
                ? result.errorKey
                : 'signin.code.errorInvalid',
            email: emailOtp?.target,
            code: code ?? ''
          })
        }

        return h.view(JOURNEY_START_VIEW, {
          backLink: getBackLink(request.yar),
          phoneEndDigits: getPhoneEndDigits(account.phone)
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { language?: string, transport?: string } }>} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_CODE_RESEND,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION },
        pre: [preHandler]
      },
      handler(request, h) {
        const isSms = request.query.transport === 'sms'
        const account = request.auth.credentials
        const email = request.yar.get(SESSION_KEY_NEW_EMAIL) // This may not exist if it's a phone code resend
        const target = isSms
          ? getPhoneEndDigits(/** @type {string} */ (account.phone))
          : email
        return h.view('account/code-resend', {
          isSms,
          target,
          email
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { language?: string } }>} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_CHANGE_EMAIL_ERROR,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION },
        pre: [preHandler]
      },
      handler(request, h) {
        const errorKey = request.yar.flash(sessionNames.changeEmailError).at(0)
        return h.view('account/change-email-error', {
          errorKey
        })
      }
    })
  ])
)

/**
 * @import { Request, ResponseToolkit, ServerRoute } from '@hapi/hapi'
 * @import { Account } from '~/src/server/types.js'
 */
