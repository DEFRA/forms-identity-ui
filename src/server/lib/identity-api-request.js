import * as fetch from '~/src/server/common/helpers/fetch.js'

/**
 * The JSON verbs for forms-identity-api, which require the caller credential
 * on every request. The token comes in as a parameter: this module only
 * attaches it, so it stays free of how tokens are minted and cached. The
 * generic fetch helper stays unauthenticated, since it is not specific to
 * this downstream service.
 * @param {string} token
 * @param {RequestOptions} options
 * @returns {RequestOptions}
 */
function authenticate(token, options) {
  return {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` }
  }
}

/**
 * @param {URL} url
 * @param {string} token
 * @param {RequestOptions} [options]
 */
export async function getJson(url, token, options = {}) {
  return fetch.getJson(url, authenticate(token, options))
}

/**
 * @param {URL} url
 * @param {string} token
 * @param {RequestOptions} [options]
 */
export async function postJson(url, token, options = {}) {
  return fetch.postJson(url, authenticate(token, options))
}

/**
 * @param {URL} url
 * @param {string} token
 * @param {RequestOptions} [options]
 */
export async function putJson(url, token, options = {}) {
  return fetch.putJson(url, authenticate(token, options))
}

/**
 * @param {URL} url
 * @param {string} token
 * @param {RequestOptions} [options]
 */
export async function delJson(url, token, options = {}) {
  return fetch.delJson(url, authenticate(token, options))
}

/**
 * @typedef {{ headers?: Record<string, string>, [key: string]: unknown }} RequestOptions
 */
