import Joi from 'joi'

import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { requestOtpViaEmail } from '~/src/server/services/otp-service.js'
import {
  INVALID_CODE,
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  INVALID_CODE_FORMAT,
  INVALID_EMAIL,
  INVALID_PHONE,
  PHONE_REQUIRED,
  RESTART,
  SIGNED_IN
} from '~/src/server/services/outcomes.js'

const emailSchema = Joi.string().email().required()

/**
 * Journey outcomes: plain data the route handlers translate into
 * responses (views, redirects, or completing the OIDC interaction)
 * @typedef {{ outcome: 'invalid-email', email: string, errorKey: string }
 *   | { outcome: 'code-sent', email: string }
 *   | { outcome: 'locked-out', lockedUntil: Date }} EmailOutcome
 * @typedef {{ outcome: 'invalid-code', errorKey: string }
 *   | { outcome: 'invalid-code-consumed-or-expired' }
 *   | { outcome: 'signed-in', accountId: string }
 *   | { outcome: 'phone-required' }} CodeOutcome
 * @typedef {{ outcome: 'invalid-phone', phone: string, errorKey: string }
 *   | { outcome: 'signed-in', accountId: string }
 *   | { outcome: 'restart' }} PhoneOutcome
 */

/**
 * Email step: UX validation here, then ask the API to mint and send a
 * code. The API independently re-validates — a UI bug can degrade error
 * messages, never security.
 *
 * The API refuses to send a code while the address is locked out for asking
 * too often, and says when the lockout lifts. Any verdict other than those
 * two is treated as a fault rather than as a code sent, so the user is never
 * told to check for an email that is not coming.
 * @param {string} uid
 * @param {string | undefined} email
 * @returns {Promise<EmailOutcome>}
 */
export async function submitEmail(uid, email) {
  const trimmed = (email ?? '').trim()
  const { error } = emailSchema.validate(trimmed)

  if (error) {
    return {
      outcome: INVALID_EMAIL,
      email: trimmed,
      errorKey: trimmed
        ? 'common.emailAddressFormatError'
        : 'common.emailAddressRequired'
    }
  }

  const result = await requestOtpViaEmail(
    uid,
    trimmed,
    PURPOSE.SIGNIN_VERIFY_EMAIL
  )
  return result
}

/**
 * Code step: the API owns what a valid code is and returns the verdict that
 * routes the journey — signed-in (existing account), phone-required (JIT arm),
 * or invalid (a wrong, expired, or malformed code: one inline error covers all)
 * @param {string} uid
 * @param {string | undefined} code
 * @returns {Promise<CodeOutcome>}
 */
export async function submitCode(uid, code) {
  const trimmed = (code ?? '').trim()

  if (!trimmed) {
    return { outcome: INVALID_CODE, errorKey: 'otp.enterCode' }
  }

  const result = await identityApi.verifyOtp(
    { uid, code: trimmed },
    await getServiceToken()
  )

  if (result.status === SIGNED_IN) {
    return { outcome: SIGNED_IN, accountId: result.accountId }
  }
  if (result.status === PHONE_REQUIRED) {
    return { outcome: PHONE_REQUIRED }
  }
  if (result.status === INVALID_CODE_FORMAT) {
    return { outcome: INVALID_CODE, errorKey: 'otp.codeFormatError' }
  }
  if (result.status === INVALID_CODE_CONSUMED_OR_EXPIRED) {
    return { outcome: INVALID_CODE_CONSUMED_OR_EXPIRED }
  }

  return { outcome: INVALID_CODE, errorKey: 'signin.code.errorInvalid' }
}

/**
 * Phone step: completes JIT signup. An `invalid` verdict means the API
 * refused the completion (no verified code — out of order or replay), so
 * the journey restarts at the email page.
 * @param {string} uid
 * @param {string | undefined} phone
 * @returns {Promise<PhoneOutcome>}
 */
export async function submitPhone(uid, phone) {
  const trimmed = (phone ?? '').trim()

  if (!trimmed) {
    return {
      outcome: INVALID_PHONE,
      phone: trimmed,
      errorKey: 'common.phoneNumberRequired'
    }
  }

  const result = await identityApi.completeSignup(
    { uid, phone: trimmed },
    await getServiceToken()
  )

  if (result.status === SIGNED_IN) {
    return { outcome: SIGNED_IN, accountId: result.accountId }
  }
  if (result.status === INVALID_PHONE) {
    return {
      outcome: INVALID_PHONE,
      phone: trimmed,
      errorKey: 'common.phoneNumberFormatError'
    }
  }
  return { outcome: RESTART }
}

/**
 * The account's current email address, for a user the client names. It
 * comes from the account rather than from the client, because the user can
 * change the address after the client got it.
 * @param {string} accountId
 * @returns {Promise<string | undefined>} undefined when the account is gone
 */
export async function getAccountEmail(accountId) {
  const account = await identityApi.getAccount(
    accountId,
    await getServiceToken()
  )

  return account?.email
}

/**
 * The email to display on the check-your-email page, from the API's stored
 * record — the same source verification uses, so the display can never
 * disagree with it. Empty when no code has been requested yet.
 * @param {string} uid
 */
export async function getSigninEmail(uid) {
  return (await identityApi.getOtpTarget(uid, await getServiceToken())) ?? ''
}
