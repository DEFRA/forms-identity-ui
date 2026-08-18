import * as fetch from '~/src/server/common/helpers/fetch.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'

/**
 * Adds the caller credential to a set of request options.
 *
 * Every request to forms-identity-api goes through here, so a call site cannot
 * reach the API without identifying itself. The generic fetch helper stays
 * unauthenticated, since it is not specific to this downstream service.
 * @param {RequestOptions} options
 * @returns {Promise<RequestOptions>}
 */
async function authenticate(options) {
  const token = await getServiceToken()

  return {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` }
  }
}

/**
 * @param {URL} url
 * @param {RequestOptions} [options]
 */
export async function getJson(url, options = {}) {
  return fetch.getJson(url, await authenticate(options))
}

/**
 * @param {URL} url
 * @param {RequestOptions} [options]
 */
export async function postJson(url, options = {}) {
  return fetch.postJson(url, await authenticate(options))
}

/**
 * @param {URL} url
 * @param {RequestOptions} [options]
 */
export async function putJson(url, options = {}) {
  return fetch.putJson(url, await authenticate(options))
}

/**
 * @param {URL} url
 * @param {RequestOptions} [options]
 */
export async function delJson(url, options = {}) {
  return fetch.delJson(url, await authenticate(options))
}

/**
 * @typedef {{ headers?: Record<string, string>, [key: string]: unknown }} RequestOptions
 */
