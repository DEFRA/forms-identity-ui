import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { formatHoursUntil } from '~/src/server/common/helpers/duration.js'
import { getLanguage } from '~/src/server/i18n/index.js'
import {
  ACCOUNT_PATH,
  PHONE_JOURNEY_START_PATH,
  codeErrorKey,
  flashResendIfRequested,
  getOtp,
  getPhoneEndDigits,
  getSessionUid,
  otpMissing,
  otpVerified,
  preHandler
} from '~/src/server/routes/account/account.js'
import { requiredSignInAuthOptions } from '~/src/server/routes/account-sign-in.js'
import { formPayload } from '~/src/server/routes/interaction.js'
import * as accountService from '~/src/server/services/account-service.js'
import { requestOtpViaEmail } from '~/src/server/services/otp-service.js'
import {
  INVALID_CODE,
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  INVALID_PHONE,
  LOCKED_OUT,
  SAME_AS_CURRENT,
  VALID
} from '~/src/server/services/outcomes.js'

const accountAction = 'change-phone'

// Views
const JOURNEY_START_VIEW = 'account/change-phone'
const ENTER_PHONE_VIEW = 'account/enter-phone'

const PATH_PREFIX = '/account/change-phone'

// Paths
const JOURNEY_SEND_CODE = `${PATH_PREFIX}/send-code`
const JOURNEY_EMAIL_CODE = `${PATH_PREFIX}/email-code`
const JOURNEY_CODE_RESEND = `${PATH_PREFIX}/code/resend`
const JOURNEY_ENTER_PHONE = `${PATH_PREFIX}/enter-phone`
const JOURNEY_CHANGE_PHONE_ERROR = `${PATH_PREFIX}/change-phone-error`

// Error mapping
const errorsLookup = /** @type {Partial<Record<string, string>>} */ ({
  [INVALID_PHONE]: 'common.phoneNumberFormatError',
  [SAME_AS_CURRENT]: 'account.newPhone.errorSameAsCurrent'
})

/**
 * Whether the email was previously verified on this journey
 * @param {string} uid
 */
async function isEmailVerified(uid) {
  return !!otpVerified(
    await getOtp(uid, PURPOSE.ACCOUNT_CHANGE_PHONE_VERIFY_EMAIL)
  )
}

/**
 * The error for a new phone the route can refuse without the API, which owns
 * the format rule
 * @param {string} phone - trimmed
 * @param {string} currentPhone
 */
function mapPhoneInputToErrorKey(phone, currentPhone) {
  if (!phone) {
    return 'common.phoneNumberRequired'
  }
  if (phone === currentPhone) {
    return 'account.newPhone.errorSameAsCurrent'
  }
  return undefined
}

export default /** @type {ServerRoute[]} */ (
  /** @type {unknown[]} */ ([
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: PHONE_JOURNEY_START_PATH,
      options: {
        ...requiredSignInAuthOptions,
        pre: [preHandler]
      },
      handler(request, h) {
        const account = /** @type {Account} */ (request.auth.credentials)

        return h.view(JOURNEY_START_VIEW, {
          email: account.email,
          backLink: {
            href: ACCOUNT_PATH
          }
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { resend?: boolean} }>} */
    ({
      method: 'POST',
      path: JOURNEY_SEND_CODE,
      options: {
        ...requiredSignInAuthOptions
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        const result = await requestOtpViaEmail(
          uid,
          account.email,
          PURPOSE.ACCOUNT_CHANGE_PHONE_VERIFY_EMAIL,
          account.id
        )

        if (result.outcome === LOCKED_OUT) {
          return h.view('account/locked-out', {
            retryAfter: formatHoursUntil(
              result.lockedUntil,
              getLanguage(request.query, request.yar)
            ),
            backLink: {
              href: ACCOUNT_PATH
            }
          })
        }

        flashResendIfRequested(request)

        return h.redirect(JOURNEY_EMAIL_CODE)
      }
    }),
    /** @satisfies {ServerRoute} */
    ({
      method: 'GET',
      path: JOURNEY_EMAIL_CODE,
      options: {
        ...requiredSignInAuthOptions,
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)

        // Verify there is an OTP record for this interaction
        // i.e. a code has been requested
        const emailOtp = await getOtp(
          uid,
          PURPOSE.ACCOUNT_CHANGE_PHONE_VERIFY_EMAIL
        )
        if (otpMissing(emailOtp)) {
          return h.redirect(PHONE_JOURNEY_START_PATH)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        return h.view('account/email-code', {
          email: emailOtp?.target,
          showResendNotification,
          accountAction,
          backLink: {
            href: PHONE_JOURNEY_START_PATH
          }
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: JOURNEY_EMAIL_CODE,
      options: {
        validate: { payload: formPayload('code') },
        ...requiredSignInAuthOptions
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { code } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        const result = await accountService.submitCode(
          uid,
          code,
          PURPOSE.ACCOUNT_CHANGE_PHONE_VERIFY_EMAIL,
          account.id
        )

        if (result.outcome === VALID) {
          return h.redirect(JOURNEY_ENTER_PHONE)
        }

        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect('/account/change-phone/code/expired')
        }

        if (result.outcome === INVALID_CODE) {
          return h.view('account/email-code', {
            errorKey: codeErrorKey(result),
            email: account.email,
            code: code ?? '',
            accountAction,
            backLink: {
              href: PHONE_JOURNEY_START_PATH
            }
          })
        }

        return h.view(JOURNEY_START_VIEW, {
          backLink: {
            href: ACCOUNT_PATH
          },
          phoneEndDigits: getPhoneEndDigits(account.phone),
          accountAction
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { language?: string, transport?: string } }>} */
    ({
      method: 'GET',
      path: JOURNEY_CODE_RESEND,
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
          backLink: {
            href: PHONE_JOURNEY_START_PATH
          }
        })
      }
    }),
    /** @satisfies {ServerRoute} */
    ({
      method: 'GET',
      path: JOURNEY_ENTER_PHONE,
      options: {
        ...requiredSignInAuthOptions,
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        // Verify the email was previously validated on this interaction
        if (!(await isEmailVerified(uid))) {
          return h.redirect(PHONE_JOURNEY_START_PATH)
        }

        return h.view(ENTER_PHONE_VIEW, {
          accountAction,
          backLink: {
            href: PHONE_JOURNEY_START_PATH
          }
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { resend?: boolean}, Payload: { phone: string } }>} */
    ({
      method: 'POST',
      path: JOURNEY_ENTER_PHONE,
      options: {
        validate: {
          payload: Joi.object({
            crumb: Joi.string().optional(),
            phone: Joi.string().allow('').required()
          })
        },
        ...requiredSignInAuthOptions
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { phone } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        // Verify the email was previously validated on this interaction
        if (!(await isEmailVerified(uid))) {
          return h.redirect(PHONE_JOURNEY_START_PATH)
        }

        const trimmed = phone.trim()
        const errorKey = mapPhoneInputToErrorKey(trimmed, account.phone)

        if (errorKey) {
          return h.view(ENTER_PHONE_VIEW, {
            phone: trimmed,
            errorKey,
            accountAction,
            backLink: {
              href: PHONE_JOURNEY_START_PATH
            }
          })
        }

        // Update the phone number in the account. This will also consume the email OTP
        const changeResult = await accountService.changePhone(
          uid,
          account.id,
          trimmed
        )

        // Failure in the API - display error page so user can follow link to re-enter email
        if (changeResult.status !== VALID) {
          const errorKeyOnChange =
            errorsLookup[changeResult.status] ??
            'account.updateError.errorGeneral'

          request.yar.flash(sessionNames.changeEmailError, errorKeyOnChange)
          if (
            changeResult.status === INVALID_PHONE ||
            changeResult.status === SAME_AS_CURRENT
          ) {
            return h.view(ENTER_PHONE_VIEW, {
              phone: trimmed,
              errorKey: errorKeyOnChange,
              accountAction,
              backLink: {
                href: PHONE_JOURNEY_START_PATH
              }
            })
          }
          return h.redirect(JOURNEY_CHANGE_PHONE_ERROR)
        }

        // Notification
        request.yar.flash(
          sessionNames.accountSuccessNotification,
          'account.successChangedPhoneNotificationText'
        )

        return h.redirect(ACCOUNT_PATH)
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { language?: string } }>} */
    ({
      method: 'GET',
      path: JOURNEY_CHANGE_PHONE_ERROR,
      options: {
        ...requiredSignInAuthOptions,
        pre: [preHandler]
      },
      handler(request, h) {
        const errorKey = request.yar.flash(sessionNames.changeEmailError).at(0)
        return h.view('account/change-error', {
          errorKey,
          accountAction,
          backLink: {
            href: JOURNEY_ENTER_PHONE
          }
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { transport: string }}>} */
    ({
      method: 'GET',
      path: '/account/change-phone/code/expired',
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
          backLink: {
            href: ACCOUNT_PATH
          }
        })
      }
    })
  ])
)

/**
 * @import { ServerRoute } from '@hapi/hapi'
 * @import { Account } from '~/src/server/types.js'
 */
