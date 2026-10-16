import Boom from '@hapi/boom'

import * as identityApi from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import {
  CODE_SENT,
  LOCKED_OUT,
  OTP_ISSUED
} from '~/src/server/services/outcomes.js'

/**
 * Wrapper for requesting an OTP via email
 * @param {string} uid
 * @param {string} email
 * @param {PurposeType} purpose
 * @param {string} [accountId]
 * @returns {Promise<{ outcome: 'code-sent', email: string } | { outcome: 'locked-out', lockedUntil: Date }>}
 */
export async function requestOtpViaEmail(uid, email, purpose, accountId) {
  const result = await identityApi.requestOtpViaEmail(
    { uid, email, purpose, accountId },
    await getServiceToken()
  )

  switch (result.status) {
    case OTP_ISSUED:
      return { outcome: CODE_SENT, email }
    case LOCKED_OUT:
      return { outcome: LOCKED_OUT, lockedUntil: new Date(result.lockedUntil) }
    default:
      throw Boom.badImplementation(
        `Unexpected code request status: ${String(/** @type {{ status?: unknown }} */ (result).status)}`
      )
  }
}

/**
 * Wrapper for requesting an OTP via SMS
 * @param {string} uid
 * @param {PurposeType} purpose
 * @param {string} accountId
 * @returns {Promise<{ outcome: 'code-sent' } | { outcome: 'locked-out', lockedUntil: Date }>}
 */
export async function requestOtpViaSms(uid, purpose, accountId) {
  const result = await identityApi.requestOtpViaSms(
    { uid, purpose, accountId },
    await getServiceToken()
  )

  switch (result.status) {
    case OTP_ISSUED:
      return { outcome: CODE_SENT }
    case LOCKED_OUT:
      return { outcome: LOCKED_OUT, lockedUntil: new Date(result.lockedUntil) }
    default:
      throw Boom.badImplementation(
        `Unexpected code request status: ${String(/** @type {{ status?: unknown }} */ (result).status)}`
      )
  }
}

/**
 * @import { PurposeType } from '~/src/server/common/constants/purposes.js'
 */
