import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import {
  INVALID_CODE,
  INVALID_CODE_CONSUMED_OR_EXPIRED,
  INVALID_CODE_FORMAT,
  VALID
} from '~/src/server/services/outcomes.js'

/**
 * Check an OTP code received on a phone.
 * @param {string} uid
 * @param {string | undefined} code
 * @returns {Promise<CodeOutcome>}
 */
export async function submitPhoneCode(uid, code) {
  return submitCode(uid, code, PURPOSE.ACCOUNT_VERIFY_PHONE)
}

/**
 * Check an OTP code received on a phone.
 * @param {string} uid
 * @param {string | undefined} code
 * @returns {Promise<CodeOutcome>}
 */
export async function submitEmailCode(uid, code) {
  return submitCode(uid, code, PURPOSE.ACCOUNT_VERIFY_EMAIL)
}

/**
 * Code step: the API owns what a valid code is and returns the verdict that
 * routes the journey — signed-in (existing account), phone-required (JIT arm),
 * or invalid (a wrong, expired, or malformed code: one inline error covers all)
 * @param {string} uid
 * @param {string | undefined} code
 * @param {PurposeType} purpose
 * @returns {Promise<CodeOutcome>}
 */
export async function submitCode(uid, code, purpose) {
  const trimmed = (code ?? '').trim()

  if (!trimmed) {
    return { outcome: INVALID_CODE, errorKey: 'signin.code.errorRequired' }
  }

  const result = await identityApi.verifyOtp(
    { uid, code: trimmed, purpose },
    await getServiceToken()
  )

  if (result.status === VALID) {
    return { outcome: VALID }
  }
  if (result.status === INVALID_CODE_FORMAT) {
    return { outcome: INVALID_CODE, errorKey: 'signin.code.errorInvalidFormat' }
  }
  if (result.status === INVALID_CODE_CONSUMED_OR_EXPIRED) {
    return { outcome: INVALID_CODE_CONSUMED_OR_EXPIRED }
  }

  return { outcome: INVALID_CODE, errorKey: 'signin.code.errorInvalid' }
}

/**
 *
 * @param {string} uid
 * @param {string} accountId
 * @param {string} email
 */
export async function changeEmailAddress(uid, accountId, email) {
  return identityApi.updateEmail(
    { uid, accountId, email },
    await getServiceToken()
  )
}

/**
 * @import { CodeOutcome } from '~/src/server/services/outcomes.js'
 * @import { PurposeType } from '~/src/server/common/constants/purposes.js'
 */
