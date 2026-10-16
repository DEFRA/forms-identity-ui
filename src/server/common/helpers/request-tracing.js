import {
  applyTraceHeaders,
  applyUserIdHeader,
  requestTracing as requestTracingPlugin
} from '@defra/forms-common'
import { tracing } from '@defra/hapi-tracing'

import { config } from '~/src/config/index.js'

const tracingHeader = config.get('tracing.header')

/**
 * Adds the correlation ID and user ID of the current log context to the
 * headers of an outbound HTTP request, so the receiving service logs the
 * same IDs
 * @param {Record<string, string>} [headers] - the existing headers
 * @returns {Record<string, string> | undefined}
 */
export function applyLogContextHeaders(headers) {
  return applyUserIdHeader(applyTraceHeaders(headers, tracingHeader))
}

/**
 * Starts a log context for every request, holding the correlation ID from the
 * tracing header (or a new ID when the caller sent none). The account ID is
 * added with `setUserId` once the sign-in or the OIDC session identifies the
 * user. The logger writes both on every log line.
 * @satisfies {ServerRegisterPluginObject<RequestTracingOptions>}
 */
export const requestTracing = {
  plugin: requestTracingPlugin,
  options: {
    tracingHeader,
    tracingPlugin: tracing.plugin
  }
}

/**
 * @import { RequestTracingOptions } from '@defra/forms-common'
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 */
