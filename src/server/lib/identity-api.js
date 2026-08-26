import { config } from '~/src/config/index.js'
import { isNotFoundError } from '~/src/server/common/helpers/fetch.js'
import { hashId } from '~/src/server/common/helpers/hash-id.js'
import { getJson, postJson } from '~/src/server/lib/identity-api-request.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'

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
 */
export async function requestOtp({ uid, email }) {
  await postJson(new URL('/otp/request', baseUrl), await getServiceToken(), {
    payload: { uid: hashId(uid), email }
  })
}

/**
 * Verifies a security code
 * @param {{ uid: string, code: string }} input
 * @returns {Promise<VerifyResult>}
 */
export async function verifyOtp({ uid, code }) {
  const { body } = await postJson(
    new URL('/otp/verify', baseUrl),
    await getServiceToken(),
    { payload: { uid: hashId(uid), code } }
  )
  return /** @type {VerifyResult} */ (body)
}

/**
 * Completes JIT signup with the recovery phone number
 * @param {{ uid: string, phone: string }} input
 * @returns {Promise<CompleteResult>}
 */
export async function completeSignup({ uid, phone }) {
  const { body } = await postJson(
    new URL('/accounts', baseUrl),
    await getServiceToken(),
    { payload: { uid: hashId(uid), phone } }
  )
  return /** @type {CompleteResult} */ (body)
}

/**
 * The email a sign-in code was sent to (display data for the
 * check-your-email page)
 * @param {string} uid
 * @returns {Promise<string | null>} null when no code has been requested
 */
export async function getOtpEmail(uid) {
  try {
    const { body } = await getJson(
      new URL(`/otp/${hashId(uid)}`, baseUrl),
      await getServiceToken()
    )
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
 * @returns {Promise<{ id: string, email: string } | null>} null when unknown
 */
export async function getAccount(id) {
  try {
    const { body } = await getJson(
      new URL(`/accounts/${encodeURIComponent(id)}`, baseUrl),
      await getServiceToken()
    )
    return /** @type {{ id: string, email: string }} */ (body)
  } catch (err) {
    if (isNotFoundError(err)) {
      return null
    }
    throw err
  }
}
