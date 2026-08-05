import { getTraceId } from '@defra/hapi-tracing'
import { ecsFormat } from '@elastic/ecs-pino-format'

import { config } from '~/src/config/index.js'
import { STATIC_PATH_PREFIXES } from '~/src/server/routes/public.js'

const logConfig = config.get('log')
const serviceName = config.get('serviceName')

/**
 * @type {{ ecs: Omit<LoggerOptions, 'mixin' | 'transport'>, 'pino-pretty': { transport: TransportSingleOptions } }}
 */
const formatters = {
  ecs: {
    ...ecsFormat(),
    base: {
      service: {
        name: serviceName,
        type: 'nodeJs'
      }
    }
  },
  'pino-pretty': { transport: { target: 'pino-pretty' } }
}

/**
 * @satisfies {Options}
 */
export const loggerOptions = {
  enabled: logConfig.enabled,
  ignorePaths: ['/health', '/favicon.ico'],
  /**
   * Keep static asset traffic out of the request logs
   * @param {Options} _options
   * @param {Request} request
   */
  ignoreFunc: (_options, request) =>
    STATIC_PATH_PREFIXES.some((prefix) => request.path.startsWith(prefix)),
  redact: {
    paths: logConfig.redact,
    remove: true
  },
  level: logConfig.level,
  ...formatters[logConfig.format],
  /**
   * @returns {{ trace?: { id: string } }}
   */
  mixin() {
    /** @type {{ trace?: { id: string } }} */
    const mixinValues = {}
    const traceId = getTraceId()
    if (traceId) {
      mixinValues.trace = { id: traceId }
    }
    return mixinValues
  }
}

/**
 * @import { Request } from '@hapi/hapi'
 * @import { Options } from 'hapi-pino'
 * @import { LoggerOptions, TransportSingleOptions } from 'pino'
 */
