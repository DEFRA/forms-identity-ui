import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { TRANSPORT } from '~/src/server/common/constants/transport.js'
import { formatHoursUntil } from '~/src/server/common/helpers/duration.js'
import { getBackLink } from '~/src/server/common/helpers/navigation.js'
import { getLanguage } from '~/src/server/i18n/index.js'
import {
  ACCOUNT_PATH,
  EMAIL_JOURNEY_START_PATH,
  auth,
  codeErrorKey,
  flashResendIfRequested,
  getOtp,
  getPhoneEndDigits,
  getSessionUid,
  otpMissing,
  otpVerified,
  preHandler
} from '~/src/server/routes/account/account.js'
import { formPayload } from '~/src/server/routes/interaction.js'
import * as accountService from '~/src/server/services/account-service.js'
import {
  requestOtpViaEmail,
  requestOtpViaSms
} from '~/src/server/services/otp-service.js'
import {
  ALREADY_IN_USE,
  INVALID_CODE,
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  LOCKED_OUT,
  SAME_AS_CURRENT,
  VALID
} from '~/src/server/services/outcomes.js'

const SESSION_KEY_NEW_EMAIL = 'session-new-email'

const accountAction = 'change-email'

// Views
const JOURNEY_START_VIEW = 'account/change-email'

const PATH_PREFIX = '/account/change-email'

// Paths
const JOURNEY_SEND_CODE = `${PATH_PREFIX}/send-code`
const JOURNEY_PHONE_SENT_CODE = `${PATH_PREFIX}/phone-sent-code`
const JOURNEY_PHONE_CODE = `${PATH_PREFIX}/phone-code`
const JOURNEY_ENTER_EMAIL = `${PATH_PREFIX}/enter-email`
const JOURNEY_EMAIL_CODE = `${PATH_PREFIX}/email-code`
const JOURNEY_CODE_RESEND = `${PATH_PREFIX}/code/resend`
const JOURNEY_CHANGE_EMAIL_ERROR = `${PATH_PREFIX}/change-email-error`

// Error mapping
const errorsLookup = /** @type {Record<string, string>} */ ({
  [SAME_AS_CURRENT]: 'account.newEmail.errorSameAsCurrent',
  [ALREADY_IN_USE]: 'account.newEmail.errorAlreadyTaken'
})

const emailSchema = Joi.string().email().required()

const transportSchema = Joi.object({
  transport: Joi.string().valid(TRANSPORT.EMAIL, TRANSPORT.SMS).required(),
  resend: Joi.boolean().optional()
})

/**
 * Whether the phone was previously verified on this journey
 * @param {string} uid
 */
async function isPhoneVerified(uid) {
  return !!otpVerified(
    await getOtp(uid, PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_PHONE)
  )
}

export default /** @type {ServerRoute[]} */ (
  /** @type {unknown[]} */ ([
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: EMAIL_JOURNEY_START_PATH,
      options: {
        auth,
        pre: [preHandler]
      },
      handler(request, h) {
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
    /** @satisfies {ServerRoute<{ Query: { transport: string, resend?: boolean} }>} */
    ({
      method: 'POST',
      path: JOURNEY_SEND_CODE,
      options: {
        auth,
        validate: {
          query: transportSchema
        }
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        const { transport } = request.query
        const isSms = transport === TRANSPORT.SMS
        const result = isSms
          ? await requestOtpViaSms(
              uid,
              PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_PHONE,
              account.id
            )
          : await requestOtpViaEmail(
              uid,
              /** @type {string} */ (request.yar.get(SESSION_KEY_NEW_EMAIL)),
              PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_EMAIL,
              account.id
            )

        if (result.outcome === LOCKED_OUT) {
          return h.view('account/locked-out', {
            retryAfter: formatHoursUntil(
              new Date(result.lockedUntil),
              getLanguage(request.query, request.yar)
            )
          })
        }

        flashResendIfRequested(request)

        return isSms
          ? h.redirect(JOURNEY_PHONE_SENT_CODE)
          : h.redirect(JOURNEY_EMAIL_CODE)
      }
    }),
    /** @satisfies {ServerRoute} */
    ({
      method: 'GET',
      path: JOURNEY_PHONE_SENT_CODE,
      options: {
        auth,
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        const phoneEndDigits = getPhoneEndDigits(account.phone)

        // Verify there is an OTP record for this interaction
        // i.e. a code has been requested
        const phoneOtp = await getOtp(
          uid,
          PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_PHONE
        )
        if (otpMissing(phoneOtp)) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        return h.view('account/phone-code', {
          phoneEndDigits,
          showResendNotification
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: JOURNEY_PHONE_CODE,
      options: {
        validate: { payload: formPayload('code') },
        auth
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { code } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)
        const result = await accountService.submitCode(
          uid,
          code,
          PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_PHONE,
          account.id
        )

        if (result.outcome === VALID) {
          return h.redirect(JOURNEY_ENTER_EMAIL)
        }

        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect('/account/change-email/code/expired/sms')
        }

        if (result.outcome === INVALID_CODE) {
          return h.view('account/phone-code', {
            backLink: getBackLink(request.yar),
            phoneEndDigits: getPhoneEndDigits(account.phone),
            errorKey: codeErrorKey(result),
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
      path: JOURNEY_ENTER_EMAIL,
      options: {
        auth,
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        // Verify the phone was previously validated on this interaction
        if (!(await isPhoneVerified(uid))) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        return h.view('account/enter-email')
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { resend?: boolean}, Payload: { email: string } }>} */
    ({
      method: 'POST',
      path: JOURNEY_ENTER_EMAIL,
      options: {
        validate: {
          payload: Joi.object({
            crumb: Joi.string().optional(),
            email: Joi.string().allow('')
          })
        },
        auth
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { email } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        // Verify the phone was previously validated on this interaction
        if (!(await isPhoneVerified(uid))) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        const trimmed = email.trim().toLowerCase()
        const { error } = emailSchema.validate(trimmed)
        const entryErrorKey = trimmed
          ? 'common.emailAddressFormatError'
          : 'common.emailAddressRequired'
        const sameEmailErrorKey =
          account.email === trimmed
            ? 'account.newEmail.errorSameAsCurrent'
            : undefined
        const errorKey = error ? entryErrorKey : sameEmailErrorKey

        if (errorKey) {
          return h.view('account/enter-email', {
            email,
            errorKey
          })
        }

        const result = await requestOtpViaEmail(
          uid,
          trimmed,
          PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_EMAIL,
          account.id
        )

        if (result.outcome === LOCKED_OUT) {
          return h.view('account/locked-out', {
            retryAfter: formatHoursUntil(
              result.lockedUntil,
              getLanguage(request.query, request.yar)
            )
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
        auth,
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)

        // Verify the phone was previously validated on this interaction
        if (!(await isPhoneVerified(uid))) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        // Verify there is an OTP record for this interaction
        // i.e. a code has been requested
        const emailOtp = await getOtp(
          uid,
          PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_EMAIL
        )
        if (otpMissing(emailOtp)) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        // Save email in session in case the user needs a resend
        request.yar.set(SESSION_KEY_NEW_EMAIL, emailOtp?.target)

        return h.view('account/email-code', {
          email: emailOtp?.target,
          showResendNotification,
          accountAction
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: JOURNEY_EMAIL_CODE,
      options: {
        validate: { payload: formPayload('code') },
        auth
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const { code } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        // Verify the phone was previously validated on this interaction
        if (!(await isPhoneVerified(uid))) {
          return h.redirect(EMAIL_JOURNEY_START_PATH)
        }

        const result = await accountService.submitCode(
          uid,
          code,
          PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_EMAIL,
          account.id
        )

        if (result.outcome === VALID) {
          // Update the email address in the account. This will also consume the email OTP
          const changeResult = await accountService.changeEmailAddress(
            uid,
            account.id
          )

          // Failure in the API - display error page so user can follow link to re-enter email
          if (changeResult.status !== VALID) {
            const errorKey =
              errorsLookup[changeResult.status] ??
              'account.updateError.errorGeneral'
            request.yar.flash(sessionNames.changeEmailError, errorKey)
            return h.redirect(JOURNEY_CHANGE_EMAIL_ERROR)
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

        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect('/account/change-email/code/expired/email')
        }

        if (result.outcome === INVALID_CODE) {
          const emailOtp = await getOtp(
            uid,
            PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_EMAIL
          )
          return h.view('account/email-code', {
            errorKey: codeErrorKey(result),
            email: emailOtp?.target,
            accountAction,
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
      path: JOURNEY_CODE_RESEND,
      options: {
        auth,
        pre: [preHandler]
      },
      handler(request, h) {
        const isSms = request.query.transport === TRANSPORT.SMS
        const account = request.auth.credentials
        const email = request.yar.get(SESSION_KEY_NEW_EMAIL) // This may not exist if it's a phone code resend
        const target = isSms
          ? getPhoneEndDigits(/** @type {string} */ (account.phone))
          : email
        return h.view('account/code-resend', {
          isSms,
          target,
          email,
          accountAction
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { language?: string } }>} */
    ({
      method: 'GET',
      path: JOURNEY_CHANGE_EMAIL_ERROR,
      options: {
        auth,
        pre: [preHandler]
      },
      handler(request, h) {
        const errorKey = request.yar.flash(sessionNames.changeEmailError).at(0)
        return h.view('account/change-error', {
          errorKey,
          accountAction
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { transport: string }}>} */
    ({
      method: 'GET',
      path: '/account/change-email/code/expired/{transport}',
      options: {
        auth,
        pre: [preHandler],
        validate: {
          params: transportSchema
        }
      },
      handler(request, h) {
        const account = request.auth.credentials
        const { transport } = request.params
        const isSms = transport === TRANSPORT.SMS
        const email = request.yar.get(SESSION_KEY_NEW_EMAIL) // This may not exist if it's a phone code resend
        const target = isSms
          ? getPhoneEndDigits(/** @type {string} */ (account.phone))
          : email
        return h.view('account/code-expired', {
          isSms,
          target,
          accountAction,
          transport
        })
      }
    })
  ])
)

/**
 * @import { ServerRoute } from '@hapi/hapi'
 * @import { Account } from '~/src/server/types.js'
 */
