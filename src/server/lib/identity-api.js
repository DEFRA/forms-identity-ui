import { config } from '~/src/config/index.js'
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
 * @param {{ uid: string, targetEmail: string, accountEmail: string }} input
 * @param {string} token
 * @param {PurposeType} purpose
 */
export async function requestOtpViaEmail(
  { uid, targetEmail, accountEmail },
  token,
  purpose
) {
  await postJson(new URL(`/otp/request/email/${purpose}`, baseUrl), {
    payload: { uid: hashId(uid), targetEmail, accountEmail },
    headers: bearerHeaders(token)
  })
}

/**
 * Mints and emails a security code for the interaction
 * @param {{ uid: string, phone: string, email:string }} input - both email and phone are required here
 * @param {string} token
 * @param {PurposeType} purpose
 */
export async function requestOtpViaSms({ uid, phone, email }, token, purpose) {
  await postJson(new URL(`/otp/request/phone/${purpose}`, baseUrl), {
    payload: { uid: hashId(uid), phone, email },
    headers: bearerHeaders(token)
  })
}

/**
 * Verifies a security code sent by email or SMS
 * @param {{ uid: string, code: string }} input
 * @param {string} token
 * @param {PurposeType} purpose
 * @returns {Promise<VerifyResult>}
 */
export async function verifyOtp({ uid, code }, token, purpose) {
  const { body } = await postJson(new URL(`/otp/verify/${purpose}`, baseUrl), {
    payload: { uid: hashId(uid), code },
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
 * @param {{ uid: string, accountId: string, email: string }} input
 * @param {string} token
 * @returns {Promise<CompleteResult>}
 */
export async function updateEmail({ uid, accountId, email }, token) {
  const { body } = await patchJson(
    new URL(`/accounts/${hashId(uid)}/${accountId}/email`, baseUrl),
    {
      payload: { email },
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
 * @import { PurposeType } from '~/src/server/common/constants/purposes.js'
 */
