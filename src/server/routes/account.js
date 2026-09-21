import { randomUUID } from 'node:crypto'

import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { sessionNames } from '~/src/server/common/constants/session-names.js'
import { getBackLink } from '~/src/server/common/helpers/navigation.js'
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

const uidParams = Joi.object({ uid: Joi.string().required() })

const queryParamsSchema = Joi.object({
  returnUrl: Joi.string()
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

export default [
  /** @type {ServerRoute} */
  ({
    method: 'GET',
    path: '/account',
    options: {
      validate: { query: queryParamsSchema },
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
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

      return h.view('account/account', {
        account,
        backLink,
        changeEmailLink: '/account/change-email',
        changePhoneLink: '/account/change-phone'
      })
    }
  }),
  /** @type {ServerRoute} */
  ({
    method: 'GET',
    path: '/account/change-email',
    options: {
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
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
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
    },
    handler(request, h) {
      const { uid } = request.params
      const account = /** @type {Account} */ (request.auth.credentials)
      const phoneEndDigits = getPhoneEndDigits(account.phone)
      const backLink = {
        href: '/account'
      }

      return h.view('account/change-email', {
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
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
    },
    async handler(request, h) {
      const { uid } = request.params
      const account = /** @type {Account} */ (request.auth.credentials)
      await identityApi.requestOtpViaSms(
        {
          uid,
          phoneNumber: account.phone,
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
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
    },
    async handler(request, h) {
      const { uid } = request.params
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
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
    },
    async handler(request, h) {
      const { uid } = request.params
      const { code } = request.payload
      const account = /** @type {Account} */ (request.auth.credentials)
      const result = await accountService.submitCode(
        uid,
        code,
        PURPOSE.ACCOUNT_VERIFY_PHONE
      )

      if (result.outcome === VALID) {
        return h.redirect(`/account/${uid}/enter-email`)
      }

      if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
        return h.redirect(`/account/${uid}/code/expired`)
      }

      return h.view('account/change-email', {
        uid,
        backLink: getBackLink(request.yar),
        phoneEndDigits: getPhoneEndDigits(account.phone)
      })
    }
  }),
  // /** @satisfies {ServerRoute<{  }>} */
  // ({
  //   method: 'GET',
  //   path: '/account/{uid}/code/expired',
  //   options: {
  //     validate: { params: uidParams }
  //   },
  //   async handler(request, h) {
  //     return commonOTPHandler(request, h, 'code-expired')
  //   }
  // }),
  /** @satisfies {ServerRoute<{ Params: { uid: string } }>} */
  ({
    method: 'GET',
    path: '/account/{uid}/enter-email',
    options: {
      validate: { params: uidParams },
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
    },
    async handler(request, h) {
      const { uid } = request.params
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
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
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
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
    },
    async handler(request, h) {
      const { uid } = request.params

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
        showResendNotification,
        backLink: { href: `/account/{${uid}}/change-email` }
      })
    }
  }),
  /** @satisfies {ServerRoute<{ Params: { uid: string }, Payload: { code?: string } }>} */
  ({
    method: 'POST',
    path: '/account/{uid}/email-code',
    options: {
      validate: { params: uidParams, payload: formPayload('code') },
      auth: { mode: 'required', strategy: CITIZEN_SESSION }
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

      const result = await accountService.submitEmailCode(uid, code)
      if (result.outcome === VALID) {
        const emailOtp = await identityApi.getOtp(
          uid,
          await getServiceToken(),
          PURPOSE.ACCOUNT_VERIFY_EMAIL
        )
        // Update the email address in the account. This will also consume the email OTP
        await accountService.changeEmailAddress(
          uid,
          account.id,
          /** @type {string} */ (emailOtp?.target)
        )
        // Consume any remainging OTPs (such as the phone OTP)
        await identityApi.cleanupOtps(uid, await getServiceToken())
        return h.redirect('/account')
      }
      if (result.outcome === INVALID_CODE_CONSUMED_OR_EXPIRED) {
        return h.redirect(`/account/${uid}/code/expired`)
      }

      return h.view('account/change-email', {
        uid,
        backLink: getBackLink(request.yar),
        phoneEndDigits: getPhoneEndDigits(account.phone)
      })
    }
  })
]

/**
 * @import { ServerRoute } from '@hapi/hapi'
 * @import { Account } from '~/src/server/types.js'
 */
