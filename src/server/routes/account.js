import { randomUUID } from 'node:crypto'

import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { getBackLink } from '~/src/server/common/helpers/navigation.js'
import { setLanguage } from '~/src/server/i18n/index.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { signedInOnly } from '~/src/server/routes/account-sign-in.js'
import { formPayload } from '~/src/server/routes/interaction.js'
import * as accountService from '~/src/server/services/account-service.js'
import {
  findClientReturn,
  storeClientReturn
} from '~/src/server/services/client-return.js'
import {
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  VALID
} from '~/src/server/services/outcomes.js'

const JOURNEY_START_PATH = 'account/change-email'

const uidParams = Joi.object({ uid: Joi.string().required() })

const queryParamsSchema = Joi.object({
  client_id: Joi.string(),
  returnUrl: Joi.string(),
  language: Joi.string().valid('en-GB', 'cy')
})

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

export default /** @type {ServerRoute[]} */ (
  /** @type {unknown[]} */ ([
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: '/account',
      options: {
        validate: { query: queryParamsSchema },
        ...signedInOnly
      },
      async handler(request, h) {
        const account = request.auth.credentials

        const { query, yar } = request
        setLanguage(request)

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
          changeEmailLink: '/account/change-email',
          changePhoneLink: '/account/change-phone',
          notificationSuccessKey
        })
      }
    }),
    /** @type {ServerRoute} */
    ({
      method: 'GET',
      path: '/account/change-email',
      options: {
        ...signedInOnly
      },
      handler(_request, h) {
        const uid = randomUUID()
        return h.redirect(`/account/${uid}/change-email`)
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { uid: string } }>} */
    ({
      method: 'GET',
      path: '/account/{uid}/change-email',
      options: {
        validate: { params: uidParams },
        ...signedInOnly
      },
      handler(request, h) {
        const { uid } = request.params
        setLanguage(request)
        const account = /** @type {Account} */ (request.auth.credentials)
        const phoneEndDigits = getPhoneEndDigits(account.phone)

        const backLink = {
          href: '/account'
        }

        return h.view(JOURNEY_START_PATH, {
          uid,
          backLink,
          phoneEndDigits
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { uid: string }, Query: { resend?: boolean} }>} */
    ({
      method: 'POST',
      path: '/account/{uid}/send-code',
      options: {
        validate: { params: uidParams },
        ...signedInOnly
      },
      async handler(request, h) {
        const { uid } = request.params
        const account = /** @type {Account} */ (request.auth.credentials)
        await identityApi.requestOtpViaSms(
          {
            uid,
            accountId: account.id,
            purpose: PURPOSE.ACCOUNT_VERIFY_PHONE
          },
          await getServiceToken()
        )

        return h.redirect(`/account/${uid}/phone-sent-code`)
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { uid: string } }>} */
    ({
      method: 'GET',
      path: '/account/{uid}/phone-sent-code',
      options: {
        validate: { params: uidParams },
        ...signedInOnly
      },
      async handler(request, h) {
        const { uid } = request.params
        setLanguage(request)
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
          return h.redirect(`/account/${uid}/change-email`)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        return h.view('account/phone-code-sent', {
          uid,
          phoneEndDigits,
          showResendNotification
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { uid: string }, Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: '/account/{uid}/phone-code',
      options: {
        validate: { params: uidParams, payload: formPayload('code') },
        ...signedInOnly
      },
      async handler(request, h) {
        const { uid } = request.params
        const { code } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)
        const result = await accountService.submitPhoneCode(
          uid,
          code,
          account.id
        )

        if (result.outcome === VALID) {
          return h.redirect(`/account/${uid}/enter-email`)
        }

        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect(`/account/${uid}/code/expired`)
        }

        return h.view(JOURNEY_START_PATH, {
          uid,
          backLink: getBackLink(request.yar),
          phoneEndDigits: getPhoneEndDigits(account.phone)
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { uid: string } }>} */
    ({
      method: 'GET',
      path: '/account/{uid}/enter-email',
      options: {
        validate: { params: uidParams },
        ...signedInOnly
      },
      async handler(request, h) {
        const { uid } = request.params
        setLanguage(request)
        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (!otpVerified(phoneOtp)) {
          return h.redirect(`/account/${uid}/change-email`)
        }

        return h.view('account/new-email', { uid })
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { uid: string }, Query: { resend?: boolean}, Payload: { email: string } }>} */
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
        ...signedInOnly
      },
      async handler(request, h) {
        const { uid } = request.params
        const { email } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (!otpVerified(phoneOtp)) {
          return h.redirect(`/account/${uid}/change-email`)
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

        return h.redirect(`/account/${uid}/email-code`)
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { uid: string } }>} */
    ({
      method: 'GET',
      path: '/account/{uid}/email-code',
      options: {
        validate: { params: uidParams },
        ...signedInOnly
      },
      async handler(request, h) {
        const { uid } = request.params
        setLanguage(request)

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )

        if (!otpVerified(phoneOtp)) {
          return h.redirect(`/account/${uid}/change-email`)
        }

        // Verify there is an OTP record for this interaction
        // i.e. a code has been requested
        const emailOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_EMAIL
        )
        if (otpMissing(emailOtp)) {
          return h.redirect(`/account/${uid}/change-email`)
        }

        const showResendNotification = request.yar
          .flash(sessionNames.codeResendSuccessNotification)
          .at(0)

        return h.view('account/email-code-sent', {
          uid,
          email: emailOtp?.target,
          showResendNotification
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Params: { uid: string }, Payload: { code?: string } }>} */
    ({
      method: 'POST',
      path: '/account/{uid}/email-code',
      options: {
        validate: { params: uidParams, payload: formPayload('code') },
        ...signedInOnly
      },
      async handler(request, h) {
        const { uid } = request.params
        const { code } = request.payload
        const account = /** @type {Account} */ (request.auth.credentials)

        // Verify the phone was previously validated on this interaction
        const phoneOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_PHONE
        )
        if (!otpVerified(phoneOtp)) {
          return h.redirect(`/account/${uid}/change-email`)
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

          return h.redirect('/account')
        }
        if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
          return h.redirect(`/account/${uid}/code/expired`)
        }

        return h.view(JOURNEY_START_PATH, {
          uid,
          backLink: getBackLink(request.yar),
          phoneEndDigits: getPhoneEndDigits(account.phone)
        })
      }
    })
  ])
)

/**
 * @import { ServerRoute } from '@hapi/hapi'
 * @import { Account } from '~/src/server/types.js'
 */
