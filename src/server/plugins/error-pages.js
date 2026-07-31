import { StatusCodes } from 'http-status-codes'

import { resolveLanguage, t } from '~/src/server/i18n/index.js'

/**
 * @param {number} statusCode
 */
function statusCodeMessageKey(statusCode) {
  switch (statusCode) {
    case StatusCodes.NOT_FOUND.valueOf():
      return 'errors.notFound.title'
    case StatusCodes.FORBIDDEN.valueOf():
      return 'errors.forbidden.title'
    case StatusCodes.UNAUTHORIZED.valueOf():
      return 'errors.unauthorized.title'
    case StatusCodes.BAD_REQUEST.valueOf():
      return 'errors.badRequest.title'
    default:
      return 'errors.serverError.title'
  }
}

/**
 * Add an `onPreResponse` listener to return error pages
 * @satisfies {ServerRegisterPluginObject<void>}
 */
export default {
  plugin: {
    name: 'error-pages',
    /**
     * @param {Server} server
     */
    register(server) {
      server.ext(
        'onPreResponse',
        /**
         * @param {Request} request
         * @param {ResponseToolkit} h
         */
        (request, h) => {
          const { response } = request

          if (!('isBoom' in response && response.isBoom)) {
            return h.continue
          }

          const statusCode = response.output.statusCode
          const message = t(
            statusCodeMessageKey(statusCode),
            resolveLanguage(request.query, request.yar)
          )

          if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR.valueOf()) {
            request.logger.error(
              response,
              `[httpError] HTTP ${statusCode} error occurred - ${response.message} - path: ${request.path} - method: ${request.method}`
            )
          }

          return h
            .view('error', {
              pageTitle: message,
              statusCode,
              message
            })
            .code(statusCode)
        }
      )
    }
  }
}

/**
 * @import { Request, ResponseToolkit, Server, ServerRegisterPluginObject } from '@hapi/hapi'
 */
