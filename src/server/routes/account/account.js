import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { formatHoursUntil } from '~/src/server/common/helpers/duration.js'
import { getBackLink } from '~/src/server/common/helpers/navigation.js'
import { getLanguage, setLanguage } from '~/src/server/i18n/index.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { requiredSignInAuthOptions } from '~/src/server/routes/account-sign-in.js'
import { formPayload } from '~/src/server/routes/interaction.js'
import * as accountService from '~/src/server/services/account-service.js'
import {
  findClientReturn,
  storeClientReturn
} from '~/src/server/services/client-return.js'
import { requestOtpViaEmail } from '~/src/server/services/otp-service.js'
import {
  INVALID_CODE,
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  LOCKED_OUT,
  VALID
} from '~/src/server/services/outcomes.js'

// Views
const DELETE_ACCOUNT_VIEW = 'account/delete-account'
const DELETE_ACCOUNT_EMAIL_CODE = 'account/email-code'
const DELETE_ACCOUNT_SUCCESS_VIEW = 'account/delete-account-success'

// Paths - account
export const ACCOUNT_PATH = '/account'
const JOURNEY_DELETE_ACCOUNT_START = '/account/delete-account'
const JOURNEY_DELETE_ACCOUNT_CODE = '/account/delete-account/email-code'
const JOURNEY_DELETE_ACCOUNT_SEND_CODE = '/account/delete-account/send-code'
const JOURNEY_DELETE_ACCOUNT_RESEND_CODE = '/account/delete-account/code/resend'
const JOURNEY_DELETE_ACCOUNT_CODE_EXPIRED =
  '/account/delete-account/code/expired'

// Paths - change email
export const EMAIL_JOURNEY_START_PATH = '/account/change-email'

// Paths - change phone number
export const PHONE_JOURNEY_START_PATH = '/account/change-phone'

const accountAction = 'delete-account'

const queryParamsSchema = Joi.object({
  client_id: Joi.string(),
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
 * @param {Request<any>} request
 * @param {string} uid
 */
export async function logoutAndRevokeGrants(request, uid) {
  // The account is already deleted when this runs, so a failure here is
  // logged rather than thrown: the user must still see the deletion succeed
  try {
    const provider = request.server.app.oidcProvider
    const session = await provider.Session.findByUid(uid)

    if (!session) {
      return
    }

    const grantIds = new Set(
      Object.values(session.authorizations ?? {})
        .map(({ grantId }) => grantId)
        .filter(Boolean)
    )

    try {
      await Promise.all(
        [...grantIds].map((grantId) =>
          provider.AccessToken.revokeByGrantId(grantId)
        )
      )
    } finally {
      await session.destroy()
    }
  } catch (error) {
    request.logger.error(
      error,
      'Failed to revoke grants or end the session after account deletion'
    )
  }
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

/**
 * @param {string} uid
 * @param {PurposeType} purpose
 */
export async function getOtp(uid, purpose) {
  return identityApi.getOtp(uid, await getServiceToken(), purpose)
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
    /** @satisfies {ServerRoute<{ Query: { client_id?: string, returnUrl?: string, language?: string } }>} */
    ({
      method: 'GET',
      path: ACCOUNT_PATH,
      options: {
        validate: { query: queryParamsSchema },
        ...requiredSignInAuthOptions,
        pre: [preHandler]
      },
      async handler(request, h) {
        const account = request.auth.credentials

        const { query, yar } = request

        const clientReturn = await findClientReturn(
          request.server.app.oidcProvider,
          { clientId: query.client_id, returnUrl: query.returnUrl }
        )

        // Only a client that names itself replaces the stored one
        if (clientReturn) {
          storeClientReturn(yar, clientReturn)
        }

        const backLink = getBackLink(yar)

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
      path: JOURNEY_DELETE_ACCOUNT_START,
      options: {
        ...requiredSignInAuthOptions,
        pre: [preHandler]
      },
      handler(request, h) {
        const account = /** @type {Account} */ (request.auth.credentials)

        return h.view(DELETE_ACCOUNT_VIEW, {
          email: account.email,
          backLink: { href: ACCOUNT_PATH }
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { resend?: boolean} }>} */
    ({
      method: 'POST',
      path: JOURNEY_DELETE_ACCOUNT_SEND_CODE,
      options: {
        ...requiredSignInAuthOptions,
        validate: {
          query: Joi.object().keys({ resend: Joi.boolean().optional() })
        }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        const result = await requestOtpViaEmail(
          uid,
          account.email,
          PURPOSE.ACCOUNT_DELETE_ACCOUNT_VERIFY_EMAIL,
          account.id
        )

        if (result.outcome === LOCKED_OUT) {
          return h.view('account/locked-out', {
            retryAfter: formatHoursUntil(
              result.lockedUntil,
              getLanguage(request.query, request.yar)
            ),
            backLink: { href: ACCOUNT_PATH }
          })
        }

        const { resend = false } = request.query

        if (resend) {
          request.yar.flash(sessionNames.codeResendSuccessNotification, true)
        }

        return h.redirect(JOURNEY_DELETE_ACCOUNT_CODE)
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { language?: string, transport?: string } }>} */
    ({
      method: 'GET',
      path: JOURNEY_DELETE_ACCOUNT_RESEND_CODE,
      options: {
        ...requiredSignInAuthOptions,
        pre: [preHandler]
      },
      handler(request, h) {
        const account = request.auth.credentials
        return h.view('account/code-resend', {
          isSms: false,
          target: account.email,
          email: account.email,
          accountAction,
          backLink: { href: JOURNEY_DELETE_ACCOUNT_START }
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'GET',
      path: JOURNEY_DELETE_ACCOUNT_CODE,
      options: {
        ...requiredSignInAuthOptions
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
        if (otpMissing(otp)) {
          return h.redirect(JOURNEY_DELETE_ACCOUNT_START)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        const errorKey = request.yar
          .flash(sessionNames.validationFailure.deleteAccountValidationFailure)
          .at(0)

        return h.view(DELETE_ACCOUNT_EMAIL_CODE, {
          backLink: { href: JOURNEY_DELETE_ACCOUNT_START },
          email: account.email,
          accountAction,
          showResendNotification,
          errorKey
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: JOURNEY_DELETE_ACCOUNT_CODE,
      options: {
        validate: { payload: formPayload('code') },
        ...requiredSignInAuthOptions
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
        if (otpMissing(otp)) {
          return h.redirect(JOURNEY_DELETE_ACCOUNT_START)
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

          await logoutAndRevokeGrants(request, uid)

          return h.view(DELETE_ACCOUNT_SUCCESS_VIEW)
        }

        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect(JOURNEY_DELETE_ACCOUNT_CODE_EXPIRED)
        }

        if (result.outcome === INVALID_CODE) {
          return h.view('account/email-code', {
            errorKey: codeErrorKey(result),
            email: account.email,
            accountAction,
            code: code ?? '',
            backLink: { href: JOURNEY_DELETE_ACCOUNT_START }
          })
        }

        return h.redirect(JOURNEY_DELETE_ACCOUNT_CODE)
      }
    }),
    /** @satisfies {ServerRoute} */
    ({
      method: 'GET',
      path: JOURNEY_DELETE_ACCOUNT_CODE_EXPIRED,
      options: {
        ...requiredSignInAuthOptions,
        pre: [preHandler]
      },
      handler(request, h) {
        const account = request.auth.credentials
        return h.view('account/code-expired', {
          isSms: false,
          target: account.email,
          accountAction,
          backLink: { href: JOURNEY_DELETE_ACCOUNT_START }
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
