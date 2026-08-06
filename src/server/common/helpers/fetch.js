import Boom from '@hapi/boom'
import Wreck from '@hapi/wreck'

const MIN_OK_STATUS = 200
const MAX_OK_STATUS = 299
const NOT_FOUND = 404

/**
 * Whether an error is the Boom 404 these helpers throw when a downstream
 * API signals "no such record"
 * @param {unknown} err
 */
export function isNotFoundError(err) {
  return Boom.isBoom(err) && err.output.statusCode === NOT_FOUND
}

/**
 * Base request function using `@hapi/wreck`
 * @param {string} method - HTTP method
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export async function request(method, url, options) {
  const response = await Wreck.request(method, url.href, options)
  // Wreck's own types promise a value, but a JSON read of an empty body
  // resolves null and any JSON scalar is a primitive
  const body = /** @type {unknown} */ (await Wreck.read(response, options))

  const statusCode = response.statusCode

  if (!statusCode || statusCode < MIN_OK_STATUS || statusCode > MAX_OK_STATUS) {
    let err

    // a bodiless or non-JSON-object error response parses to null or a
    // primitive, which the `in` operator rejects — the status code must
    // survive either way so callers can still classify the failure
    if (
      typeof body === 'object' &&
      body !== null &&
      'message' in body &&
      typeof body.message === 'string' &&
      body.message
    ) {
      const cause = 'cause' in body ? body.cause : undefined
      err = new Error(body.message, { cause })
    } else {
      err = new Error(`HTTP status code ${statusCode}`)
    }

    throw Boom.boomify(err, { statusCode, data: body })
  }

  return { response, body }
}

/**
 * GET request
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function get(url, options) {
  return request('get', url, options)
}

/**
 * POST request
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function post(url, options) {
  return request('post', url, options)
}

/**
 * PUT request
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function put(url, options) {
  return request('put', url, options)
}

/**
 * PATCH request
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function patch(url, options) {
  return request('patch', url, options)
}

/**
 * DELETE request
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function del(url, options) {
  return request('delete', url, options)
}

/**
 * GET request with JSON parsing
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function getJson(url, options = {}) {
  return get(url, { json: true, ...options })
}

/**
 * POST request with JSON parsing
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function postJson(url, options = {}) {
  return post(url, { json: true, ...options })
}

/**
 * PUT request with JSON parsing
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function putJson(url, options = {}) {
  return put(url, { json: true, ...options })
}

/**
 * PATCH request with JSON parsing
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function patchJson(url, options = {}) {
  return patch(url, { json: true, ...options })
}

/**
 * DELETE request with JSON parsing
 * @param {URL} url - URL object
 * @param {object} options - Request options
 * @returns {Promise<{response: object, body: unknown}>}
 */
export function delJson(url, options = {}) {
  return del(url, { json: true, ...options })
}
