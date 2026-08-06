import Joi from 'joi'

import { joi as telephoneJoi } from '~/src/server/common/helpers/telephone.js'
import * as identityApi from '~/src/server/lib/identity-api.js'

/** Outcomes named once, so a typo cannot silently change a journey */
const INVALID_CODE = 'invalid-code'
const INVALID_PHONE = 'invalid-phone'
const SIGNED_IN = 'signed-in'

const emailSchema = Joi.string().email().required()
const phoneSchema =
  /** @type {import('~/src/server/common/helpers/telephone.js').TelephoneSchema} */ (
    telephoneJoi.string()
  )
    .phoneNumber()
    .required()

/**
 * Journey outcomes: plain data the route handlers translate into
 * responses (views, redirects, or completing the OIDC interaction)
 * @typedef {{ outcome: 'invalid-email', email: string, errorKey: string }
 *   | { outcome: 'code-sent', email: string }} EmailOutcome
 * @typedef {{ outcome: 'invalid-code', errorKey: string }
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
 * @param {string} uid
 * @param {string | undefined} email
 * @returns {Promise<EmailOutcome>}
 */
export async function submitEmail(uid, email) {
  const trimmed = (email ?? '').trim()
  const { error } = emailSchema.validate(trimmed)

  if (error) {
    return {
      outcome: 'invalid-email',
      email: trimmed,
      errorKey: trimmed
        ? 'signin.email.errorFormat'
        : 'signin.email.errorRequired'
    }
  }

  await identityApi.requestOtp({ uid, email: trimmed })

  return { outcome: 'code-sent', email: trimmed }
}

/**
 * Code step: the API's verdict routes the journey — signed-in (existing
 * account), phone-required (JIT arm), or invalid (which includes expired
 * codes: one inline error covers both)
 * @param {string} uid
 * @param {string | undefined} code
 * @returns {Promise<CodeOutcome>}
 */
export async function submitCode(uid, code) {
  const trimmed = (code ?? '').trim()

  if (!trimmed) {
    return { outcome: INVALID_CODE, errorKey: 'signin.code.errorRequired' }
  }

  // shape check before the downstream call — the API's route validation
  // rejects malformed codes as a 400 (client bug), so they must never
  // leave this service
  if (!/^\d{6}$/.test(trimmed)) {
    return { outcome: INVALID_CODE, errorKey: 'signin.code.errorInvalid' }
  }

  const result = await identityApi.verifyOtp({ uid, code: trimmed })

  if (result.status === SIGNED_IN) {
    return { outcome: SIGNED_IN, accountId: result.accountId }
  }
  if (result.status === 'phone-required') {
    return { outcome: 'phone-required' }
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
      errorKey: 'signin.phone.errorRequired'
    }
  }

  // shape check before the downstream call — the API's route validation
  // applies the same telephone rule and rejects non-numbers as a 400, so
  // they must never leave this service; whether the number is a MOBILE is
  // the API's business rule, returned as an invalid-phone verdict
  if (phoneSchema.validate(trimmed).error) {
    return {
      outcome: INVALID_PHONE,
      phone: trimmed,
      errorKey: 'signin.phone.errorInvalid'
    }
  }

  const result = await identityApi.completeSignup({ uid, phone: trimmed })

  if (result.status === SIGNED_IN) {
    return { outcome: SIGNED_IN, accountId: result.accountId }
  }
  if (result.status === INVALID_PHONE) {
    return {
      outcome: INVALID_PHONE,
      phone: trimmed,
      errorKey: 'signin.phone.errorInvalid'
    }
  }
  return { outcome: 'restart' }
}

/**
 * The email to display on the check-your-email page, from the API's stored
 * record — the same source verification uses, so the display can never
 * disagree with it. Empty when no code has been requested yet.
 * @param {string} uid
 */
export async function getSigninEmail(uid) {
  return (await identityApi.getOtpEmail(uid)) ?? ''
}
