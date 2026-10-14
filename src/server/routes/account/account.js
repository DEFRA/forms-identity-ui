import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import {
  SESSION_KEY_BACK_LINK,
  sessionNames
} from '~/src/server/common/constants/session-names.js'
import { setLanguage } from '~/src/server/i18n/index.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { CITIZEN_SESSION } from '~/src/server/plugins/scheme.js'
import { formPayload } from '~/src/server/routes/interaction.js'
import * as accountService from '~/src/server/services/account-service.js'
import {
  INVALID_CODE,
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  VALID
} from '~/src/server/services/outcomes.js'

// Views
const DELETE_ACCOUNT_VIEW = 'account/delete-account'
const DELETE_ACCOUNT_SUCCESS_VIEW = 'account/delete-account-success'
const DELETE_ACCOUNT_CODE_EXPIRED_VIEW = 'account/delete-account-code-expired'

// Paths - account
export const ACCOUNT_PATH = '/account'
const EMAIL_JOURNEY_DELETE_ACCOUNT_SEND_CODE =
  '/account/delete-account/send-code'
const EMAIL_JOURNEY_DELETE_ACCOUNT_CODE = '/account/delete-account'
const EMAIL_JOURNEY_DELETE_ACCOUNT_CODE_EXPIRED =
  '/account/delete-account/code-expired'

// Paths - change email
export const EMAIL_JOURNEY_START_PATH = '/account/change-email'

// Paths - change phone number
export const PHONE_JOURNEY_START_PATH = '/account/change-phone'

const queryParamsSchema = Joi.object({
  returnUrl: Joi.string(),
  language: Joi.string().valid('en-GB', 'cy')
})

/* eslint-disable jsdoc/reject-any-type -- hapi request refs are invariant, so only any-ref helpers can be shared by payload-narrowed routes */

/**
 * Get the session UID (preventing it from being in a URL route param)
 * so that back-end records from a different user cannot be interposed.
 * @param {Request<any>} request
 */
export function getSessionUid(request) {
  return /** @type {string} */ (request.auth.artifacts.sessionUid)
}

/**
 * Gets last 4 digits of phone number
 * @param {string} phone
 * @returns {string}
 */
export function getPhoneEndDigits(phone) {
  return phone.substring(phone.length - 4)
}

/**
 * @param {{ consumed: boolean, verified: boolean, target: string } | null } otp
 */
export function otpVerified(otp) {
  return otp && !otp.consumed && otp.verified
}

/**
 * @param {{ consumed: boolean, verified: boolean, target: string } | null } otp
 */
export function otpMissing(otp) {
  return !otp || otp.consumed
}

/**
 * Ensure any language parameters are actioned, so the user can switch languages on any page.
 * @param {Request<any>} request
 * @param {ResponseToolkit<any>} h
 */
function preHandlerMethod(request, h) {
  setLanguage(request)
  return h.response()
}

/** The pre entry every /account route that renders a page must carry */
export const preHandler = {
  method: preHandlerMethod
}

export const auth = /** @type {const} */ ({
  mode: 'required',
  strategy: CITIZEN_SESSION
})

/**
 * @param {string} uid
 * @param {PurposeType} purpose
 */
export async function getOtp(uid, purpose) {
  return identityApi.getOtp(uid, await getServiceToken(), purpose)
}

/**
 * @param {{ outcome: string }} result
 */
export function isInvalidCode(result) {
  return (
    result.outcome === INVALID_CODE ||
    result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED
  )
}

/**
 * @param {object} result
 */
export function codeErrorKey(result) {
  return 'errorKey' in result && typeof result.errorKey === 'string'
    ? result.errorKey
    : 'signin.code.errorInvalid'
}

/**
 * @param {Request<any>} request
 */
export function flashResendIfRequested(request) {
  if (request.query.resend) {
    request.yar.flash(sessionNames.codeResendSuccessNotification, true)
  }
}

export default /** @type {ServerRoute[]} */ (
  /** @type {unknown[]} */ ([
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: ACCOUNT_PATH,
      options: {
        validate: { query: queryParamsSchema },
        auth,
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
    /** @satisfies {ServerRoute<{ Query: { resend?: boolean} }>} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_DELETE_ACCOUNT_SEND_CODE,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION },
        validate: {
          query: Joi.object().keys({ resend: Joi.boolean().optional() })
        }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        await identityApi.requestOtpViaEmail(
          {
            uid,
            email: account.email,
            accountId: account.id,
            purpose: PURPOSE.ACCOUNT_DELETE_ACCOUNT_VERIFY_EMAIL
          },
          await getServiceToken()
        )

        const { resend = false } = request.query

        if (resend) {
          request.yar.flash(sessionNames.codeResendSuccessNotification, true)
        }

        return h.redirect(EMAIL_JOURNEY_DELETE_ACCOUNT_CODE)
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_DELETE_ACCOUNT_CODE,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)

        // Verify the email was previously initialized for this purpose
        const otp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_DELETE_ACCOUNT_VERIFY_EMAIL
        )
        if (!otp || otpVerified(otp)) {
          return h.redirect(ACCOUNT_PATH)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        const errorKey = request.yar
          .flash(sessionNames.validationFailure.deleteAccountValidationFailure)
          .at(0)

        return h.view(DELETE_ACCOUNT_VIEW, {
          backLink: { href: ACCOUNT_PATH },
          email: account.email,
          showResendNotification,
          errorKey
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: EMAIL_JOURNEY_DELETE_ACCOUNT_CODE,
      options: {
        validate: { payload: formPayload('code') },
        auth: { mode: 'required', strategy: CITIZEN_SESSION }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { code } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        // Verify the email was previously initialized for this purpose
        const otp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_DELETE_ACCOUNT_VERIFY_EMAIL
        )
        if (!otp || otpVerified(otp)) {
          return h.redirect(ACCOUNT_PATH)
        }

        const result = await accountService.submitCode(
          uid,
          code,
          PURPOSE.ACCOUNT_DELETE_ACCOUNT_VERIFY_EMAIL,
          account.id
        )

        if (result.outcome === VALID) {
          // Delete the account
          await accountService.deleteAccount(uid, account.id)

          // TODO: Logout the user

          return h.view(DELETE_ACCOUNT_SUCCESS_VIEW)
        }

        if (result.outcome === INVALID_CODE) {
          request.yar.flash(
            sessionNames.validationFailure.deleteAccountValidationFailure,
            result.errorKey
          )
          return h.redirect(EMAIL_JOURNEY_DELETE_ACCOUNT_CODE)
        }

        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect(EMAIL_JOURNEY_DELETE_ACCOUNT_CODE_EXPIRED)
        }

        return h.redirect(EMAIL_JOURNEY_DELETE_ACCOUNT_CODE)
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_DELETE_ACCOUNT_CODE_EXPIRED,
      options: {
        auth: { mode: 'required', strategy: CITIZEN_SESSION }
      },
      handler(request, h) {
        const account = /** @type {Account} */ (request.auth.credentials)

        return h.view(DELETE_ACCOUNT_CODE_EXPIRED_VIEW, {
          backLink: { href: ACCOUNT_PATH },
          email: account.email
        })
      }
    })
  ])
)

/**
 * @import { Request, ResponseToolkit, ServerRoute } from '@hapi/hapi'
 * @import { PurposeType } from '~/src/server/common/constants/purposes.js'
 * @import { Account } from '~/src/server/types.js'
 */
