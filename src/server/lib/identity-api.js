import { config } from '~/src/config/index.js'
import {
  bearerHeaders,
  getJson,
  isNotFoundError,
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
 * @typedef {{ status: 'invalid' } | { status: 'phone-required' } | { status: 'signed-in', accountId: string }} VerifyResult
 * @typedef {{ status: 'invalid' } | { status: 'invalid-phone' } | { status: 'signed-in', accountId: string }} CompleteResult
 */

/**
 * Mints and emails a security code for the interaction
 * @param {{ uid: string, email: string }} input
 * @param {string} token
 */
export async function requestOtp({ uid, email }, token) {
  await postJson(new URL('/otp/request', baseUrl), {
    payload: { uid: hashId(uid), email },
    headers: bearerHeaders(token)
  })
}

/**
 * Verifies a security code
 * @param {{ uid: string, code: string }} input
 * @param {string} token
 * @returns {Promise<VerifyResult>}
 */
export async function verifyOtp({ uid, code }, token) {
  const { body } = await postJson(new URL('/otp/verify', baseUrl), {
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
 * The email a sign-in code was sent to (display data for the
 * check-your-email page)
 * @param {string} uid
 * @param {string} token
 * @returns {Promise<string | null>} null when no code has been requested
 */
export async function getOtpEmail(uid, token) {
  try {
    const { body } = await getJson(new URL(`/otp/${hashId(uid)}`, baseUrl), {
      headers: bearerHeaders(token)
    })
    return /** @type {{ email: string }} */ (body).email
  } catch (err) {
    if (isNotFoundError(err)) {
      return null
    }
    throw err
  }
}

/**
 * Account lookup backing the provider's claims/userinfo
 * @param {string} id
 * @param {string} token
 * @returns {Promise<{ id: string, email: string } | null>} null when unknown
 */
export async function getAccount(id, token) {
  try {
    const { body } = await getJson(
      new URL(`/accounts/${encodeURIComponent(id)}`, baseUrl),
      { headers: bearerHeaders(token) }
    )
    return /** @type {{ id: string, email: string }} */ (body)
  } catch (err) {
    if (isNotFoundError(err)) {
      return null
    }
    throw err
  }
}
