import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { getBackLink } from '~/src/server/common/helpers/navigation.js'
import { joi as telephoneJoi } from '~/src/server/common/helpers/telephone.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import {
  ACCOUNT_PATH,
  PHONE_JOURNEY_START_PATH,
  auth,
  codeErrorKey,
  flashResendIfRequested,
  getOtp,
  getPhoneEndDigits,
  getSessionUid,
  isInvalidCode,
  otpMissing,
  otpVerified,
  preHandler
} from '~/src/server/routes/account/account.js'
import { formPayload } from '~/src/server/routes/interaction.js'
import * as accountService from '~/src/server/services/account-service.js'
import {
  INVALID_PHONE,
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
const errorsLookup = /** @type {Record<string, string>} */ ({
  [INVALID_PHONE]: 'account.newPhone.errorFormat',
  [SAME_AS_CURRENT]: 'account.newPhone.errorSameAsCurrent'
})

const phoneSchema = /** @type {TelephoneSchema} */ (telephoneJoi.string())
  .phoneNumber()
  .required()

/**
 * Whether the email was previously verified on this journey
 * @param {string} uid
 */
async function isEmailVerified(uid) {
  return !!otpVerified(
    await getOtp(uid, PURPOSE.ACCOUNT_CHANGE_PHONE_VERIFY_EMAIL)
  )
}

export default /** @type {ServerRoute[]} */ (
  /** @type {unknown[]} */ ([
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: PHONE_JOURNEY_START_PATH,
      options: {
        auth,
        pre: [preHandler]
      },
      handler(request, h) {
        const account = /** @type {Account} */ (request.auth.credentials)

        const backLink = {
          href: ACCOUNT_PATH
        }

        return h.view(JOURNEY_START_VIEW, {
          backLink,
          email: account.email
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Query: { resend?: boolean} }>} */
    ({
      method: 'POST',
      path: JOURNEY_SEND_CODE,
      options: {
        auth
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        await identityApi.requestOtpViaEmail(
          {
            uid,
            email: account.email,
            purpose: PURPOSE.ACCOUNT_CHANGE_PHONE_VERIFY_EMAIL,
            accountId: account.id
          },
          await getServiceToken()
        )

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

        return h.view('account/email-code-sent', {
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

        const result = await accountService.submitCode(
          uid,
          code,
          PURPOSE.ACCOUNT_CHANGE_PHONE_VERIFY_EMAIL,
          account.id
        )

        if (result.outcome === VALID) {
          return h.redirect(JOURNEY_ENTER_PHONE)
        }

        if (isInvalidCode(result)) {
          return h.view('account/email-code', {
            errorKey: codeErrorKey(result),
            email: account.email,
            code: code ?? '',
            accountAction
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
        const account = request.auth.credentials
        return h.view('account/code-resend', {
          isSms: false,
          target: account.email,
          email: account.email,
          accountAction
        })
      }
    }),
    /** @satisfies {ServerRoute} */
    ({
      method: 'GET',
      path: JOURNEY_ENTER_PHONE,
      options: {
        auth,
        pre: [preHandler]
      },
      async handler(request, h) {
        const uid = getSessionUid(request)
        // Verify the email was previously validated on this interaction
        if (!(await isEmailVerified(uid))) {
          return h.redirect(PHONE_JOURNEY_START_PATH)
        }

        return h.view(ENTER_PHONE_VIEW)
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
            phone: Joi.string().allow('')
          })
        },
        auth
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
        const { error } = phoneSchema.validate(trimmed)

        let errorKey
        if (error) {
          if (!trimmed) {
            errorKey = 'account.newPhone.errorRequired'
          } else {
            errorKey = 'account.newPhone.errorFormat'
          }
        } else if (account.phone === trimmed) {
          errorKey = 'account.newPhone.errorSameAsCurrent'
        }

        if (errorKey) {
          return h.view(ENTER_PHONE_VIEW, {
            phone: trimmed,
            errorKey
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
          if (changeResult.status === INVALID_PHONE) {
            return h.view(ENTER_PHONE_VIEW, {
              phone: trimmed,
              errorKey: errorKeyOnChange
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
    })
  ])
)

/**
 * @import { ServerRoute } from '@hapi/hapi'
 * @import { Account } from '~/src/server/types.js'
 * @import { TelephoneSchema } from '~/src/server/common/helpers/telephone.js'
 */
