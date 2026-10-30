import {
  applyLogContextHeaders as applyLogContextHeader,
  applyTraceHeaders as applyTraceHeader,
  applyUserIdHeader,
  requestTracing as requestTracingPlugin
} from '@defra/forms-common'
import { tracing } from '@defra/hapi-tracing'

import { config } from '~/src/config/index.js'

const tracingHeader = config.get('tracing.header')

/**
 * Origins of the forms services the UI calls. The user ID and session ID are
 * only sent to these, never to a service outside forms.
 */
const formsServiceOrigins = new Set(
  [config.get('identityApi.url')]
    .filter((serviceUrl) => URL.canParse(serviceUrl))
    .map((serviceUrl) => new URL(serviceUrl).origin)
)

/**
 * Adds the correlation ID of the current log context to the headers of an
 * outbound HTTP request, so the receiving service logs the same ID
 * @param {Record<string, string>} [headers] - the existing headers
 * @returns {Record<string, string> | undefined}
 */
export function applyTraceHeaders(headers) {
  return applyTraceHeader(headers, tracingHeader)
}

/**
 * Adds the user ID and session ID of the current log context to the headers
 * of an outbound HTTP request, when the request is to another forms service
 * @param {URL} url - the URL of the request
 * @param {Record<string, string>} [headers] - the existing headers
 * @returns {Record<string, string> | undefined}
 */
export function applyLogContextHeaders(url, headers) {
  if (!formsServiceOrigins.has(url.origin)) {
    return headers
  }

  return applyLogContextHeader(applyUserIdHeader(headers))
}

/**
 * Gets the ID of the yar session, which the session plugin loads in `onPreAuth`
 * @param {Request} request
 * @returns {string | null | undefined}
 */
export function getRequestSessionId(request) {
  // `request.yar` is only set when the yar plugin is registered
  const { yar } = /** @type {Partial<Pick<Request, 'yar'>>} */ (request)

  return yar?.id
}

/**
 * Starts a log context for every request, holding the correlation ID from the
 * tracing header (or a new ID when the caller sent none) and the ID of the yar
 * session. The account ID is added with `setUserId` once the sign-in or the
 * OIDC session identifies the user. The logger writes them on every log line.
 *
 * Browsers call this service, so it does not read the session ID or form
 * reference number headers (`readLogContextHeaders`).
 * @satisfies {ServerRegisterPluginObject<RequestTracingOptions>}
 */
export const requestTracing = {
  plugin: requestTracingPlugin,
  options: {
    tracingHeader,
    tracingPlugin: tracing.plugin,
    getSessionId: getRequestSessionId
  }
}

/**
 * @import { RequestTracingOptions } from '@defra/forms-common'
 * @import { Request, ServerRegisterPluginObject } from '@hapi/hapi'
 */
