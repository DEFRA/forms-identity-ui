import { config } from '~/src/config/index.js'
import { getJson, postJson } from '~/src/server/common/helpers/fetch.js'

const baseUrl = config.get('identityApi.url')

/**
 * Downstream client for forms-identity-api (internal network). Thin
 * transport wrappers only — journey decisions live in the signin service.
 * @typedef {{ status: 'invalid' } | { status: 'expired' } | { status: 'phone-required' } | { status: 'signed-in', accountId: string }} VerifyResult
 * @typedef {{ status: 'invalid' } | { status: 'invalid-phone' } | { status: 'signed-in', accountId: string }} CompleteResult
 */

/**
 * Mints and emails a security code for the interaction
 * @param {{ uid: string, email: string }} input
 */
export async function requestOtp({ uid, email }) {
  await postJson(new URL('/otp/request', baseUrl), {
    payload: { uid, email }
  })
}

/**
 * Verifies a security code
 * @param {{ uid: string, code: string }} input
 * @returns {Promise<VerifyResult>}
 */
export async function verifyOtp({ uid, code }) {
  const { body } = await postJson(new URL('/otp/verify', baseUrl), {
    payload: { uid, code }
  })
  return /** @type {VerifyResult} */ (body)
}

/**
 * Completes JIT signup with the recovery phone number
 * @param {{ uid: string, phone: string }} input
 * @returns {Promise<CompleteResult>}
 */
export async function completeSignup({ uid, phone }) {
  const { body } = await postJson(new URL('/accounts', baseUrl), {
    payload: { uid, phone }
  })
  return /** @type {CompleteResult} */ (body)
}

/**
 * Account lookup backing the provider's claims/userinfo
 * @param {string} id
 * @returns {Promise<{ id: string, email: string } | null>} null when unknown
 */
export async function getAccount(id) {
  try {
    const { body } = await getJson(
      new URL(`/accounts/${encodeURIComponent(id)}`, baseUrl)
    )
    return /** @type {{ id: string, email: string }} */ (body)
  } catch (err) {
    if (
      err instanceof Error &&
      'isBoom' in err &&
      'output' in err &&
      /** @type {{ output: { statusCode: number } }} */ (err).output
        .statusCode === 404
    ) {
      return null
    }
    throw err
  }
}
