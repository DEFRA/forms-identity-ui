import { StatusCodes } from 'http-status-codes'

/**
 * Add an `onPreResponse` listener to return error pages: a dedicated 404
 * view, and the 500 view for every other Boom error with its original
 * status code preserved
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

          if (statusCode === StatusCodes.NOT_FOUND.valueOf()) {
            return h.view('404').code(statusCode)
          }

          // Client errors are routine — a stale crumb, a bot probing, a
          // malformed parameter — and the user is told what to do by the
          // page itself. Only a genuine server fault is worth waking
          // someone up for, so only that is logged at error level.
          if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR.valueOf()) {
            request.logger.error(
              response,
              `[httpError] HTTP ${statusCode} error occurred - ${response.message} - path: ${request.path} - method: ${request.method}`
            )
          }

          return h.view('500').code(statusCode)
        }
      )
    }
  }
}

/**
 * @import { Request, ResponseToolkit, Server, ServerRegisterPluginObject } from '@hapi/hapi'
 */
