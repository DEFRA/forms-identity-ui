import { config } from '~/src/config/index.js'
import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { TRANSPORT } from '~/src/server/common/constants/transport.js'
import {
  bearerHeaders,
  delJson,
  getJson,
  isNotFoundError,
  patchJson,
  postJson
} from '~/src/server/common/helpers/fetch.js'
import { hashId } from '~/src/server/common/helpers/hash-id.js'

const baseUrl = config.get('identityApi.url')

/**
 * Downstream client for forms-identity-api (internal network). Thin
 * transport wrappers only — journey decisions live in the signin service.
 *
 * The interaction uid is also the `_interaction` cookie value, so every call
 * keys the OTP record by a digest of it rather than the uid itself. The API
 * treats the uid as an opaque string, and the digest is deterministic, so it
 * stores and matches the digest with no change of its own. All four sites
 * have to agree: a digest on one side and a plaintext uid on the other gives
 * a 404, not an error.
 * @typedef {{ status: 'invalid' } | { status: 'invalid-code-format' } | { status: 'invalid-code-consumed-or-expired' } | { status: 'phone-required' } | { status: 'signed-in', accountId: string } | { status: 'valid' }} VerifyResult
 * @typedef {{ status: 'invalid' } | { status: 'invalid-phone' } | { status: 'signed-in', accountId: string }} CompleteResult
 */

/**
 * Mints and emails a security code for the interaction
 * @param {{ uid: string, email: string, purpose: PurposeType, accountId?: string }} input
 * @param {string} token
 */
export async function requestOtpViaEmail(
  { uid, email, purpose, accountId },
  token
) {
  await postJson(new URL('/otp/request', baseUrl), {
    payload: {
      uid: hashId(uid),
      target: email,
      transport: TRANSPORT.EMAIL,
      purpose,
      accountId
    },
    headers: bearerHeaders(token)
  })
}

/**
 * Mints and emails a security code for the interaction.
 * The phone number is not passed here, but read from the account record in the DB.
 * @param {{ uid: string, accountId: string, purpose: PurposeType }} input
 * @param {string} token
 */
export async function requestOtpViaSms({ uid, accountId, purpose }, token) {
  await postJson(new URL('/otp/request', baseUrl), {
    payload: {
      uid: hashId(uid),
      accountId,
      transport: TRANSPORT.SMS,
      purpose
    },
    headers: bearerHeaders(token)
  })
}

/**
 * Verifies a security code
 * @param {{ uid: string, code: string, purpose?: PurposeType, id?: string }} input
 * @param {string} token
 * @returns {Promise<VerifyResult>}
 */
export async function verifyOtp(
  { uid, code, id, purpose = PURPOSE.SIGNIN_VERIFY_EMAIL },
  token
) {
  const { body } = await postJson(new URL('/otp/verify', baseUrl), {
    payload: { uid: hashId(uid), code, purpose, id },
    headers: bearerHeaders(token)
  })
  return /** @type {VerifyResult} */ (body)
}

/**
 * Completes JIT signup with the recovery phone number
 * @param {{ uid: string, phone: string }} input
 * @param {string} token
 * @returns {Promise<CompleteResult>}
 */
export async function completeSignup({ uid, phone }, token) {
  const { body } = await postJson(new URL('/accounts', baseUrl), {
    payload: { uid: hashId(uid), phone },
    headers: bearerHeaders(token)
  })
  return /** @type {CompleteResult} */ (body)
}

/**
 * The OTP target (email or sms) that was sent a code (display data for the
 * check-your-email/check-your-phone page)
 * @param {string} uid
 * @param {string} token
 * @param {PurposeType} [purpose]
 * @returns {Promise<string | null>} null when no code has been requested
 */
export async function getOtpTarget(
  uid,
  token,
  purpose = PURPOSE.SIGNIN_VERIFY_EMAIL
) {
  const otp = await getOtp(uid, token, purpose)
  return otp?.target ?? null
}

/**
 * Account lookup backing the provider's claims/userinfo and the account page
 * @param {string} id
 * @param {string} token
 * @returns {Promise<{ id: string, email: string, phone?: string } | null>} null when unknown
 */
export async function getAccount(id, token) {
  try {
    const { body } = await getJson(
      new URL(`/accounts/${encodeURIComponent(id)}`, baseUrl),
      { headers: bearerHeaders(token) }
    )
    return /** @type {{ id: string, email: string, phone?: string }} */ (body)
  } catch (err) {
    if (isNotFoundError(err)) {
      return null
    }
    throw err
  }
}

/**
 * Information regarding a sign-in code (sucha as target it was sent to (display data for the
 * check-your-email page), whether ist has been consumed, and whether it has been verified.
 * @param {string} uid
 * @param {string} token
 * @param {PurposeType} purpose
 * @returns {Promise<{ target: string, verified: boolean, consumed: boolean } | null >} null when no code has been requested
 */
export async function getOtp(uid, token, purpose) {
  try {
    const { body } = await getJson(
      new URL(`/otp/${hashId(uid)}/${purpose}`, baseUrl),
      {
        headers: bearerHeaders(token)
      }
    )
    const bodyTyped =
      /** @type {{ target: string, verified: boolean, consumed: boolean }} */ (
        body
      )
    return {
      target: bodyTyped.target,
      consumed: bodyTyped.consumed,
      verified: bodyTyped.verified
    }
  } catch (err) {
    if (isNotFoundError(err)) {
      return null
    }
    throw err
  }
}

/**
 * Completes JIT change email address
 * @param {{ uid: string, accountId: string }} input
 * @param {string} token
 * @returns {Promise<CompleteResult>}
 */
export async function updateEmail({ uid, accountId }, token) {
  const { body } = await patchJson(
    new URL(`/accounts/${hashId(uid)}/${accountId}/email`, baseUrl),
    {
      headers: bearerHeaders(token)
    }
  )
  return /** @type {CompleteResult} */ (body)
}

/**
 * Remove any OTPs associated with an interaction uid
 * @param {string} uid
 * @param {string} token
 */
export async function cleanupOtps(uid, token) {
  try {
    await delJson(new URL(`/otp/${hashId(uid)}`, baseUrl), {
      headers: bearerHeaders(token)
    })
  } catch {
    // Swallow any errors
  }
}

/**
 * @import { PurposeType } from '~/src/server/common/constants/purposes.js'
 */
