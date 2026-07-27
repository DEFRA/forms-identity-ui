import { StatusCodes } from 'http-status-codes'

/**
 * @param {number} statusCode
 */
function statusCodeMessage(statusCode) {
  switch (statusCode) {
    case StatusCodes.NOT_FOUND.valueOf():
      return 'Page not found'
    case StatusCodes.FORBIDDEN.valueOf():
      return 'Forbidden'
    case StatusCodes.UNAUTHORIZED.valueOf():
      return 'Unauthorized'
    case StatusCodes.BAD_REQUEST.valueOf():
      return 'Bad request'
    default:
      return 'Sorry, there is a problem with the service'
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
          const message = statusCodeMessage(statusCode)

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
