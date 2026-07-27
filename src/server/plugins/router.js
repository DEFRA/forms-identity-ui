import { StatusCodes } from 'http-status-codes'

import { config } from '~/src/config/index.js'
import { healthRoute, homeRoute } from '~/src/server/routes/index.js'

const assetPath = config.get('assetPath')

/**
 * Registers the application routes and static asset handling
 * @satisfies {ServerRegisterPluginObject<void>}
 */
export default {
  plugin: {
    name: 'router',
    /**
     * @param {Server} server
     */
    register(server) {
      server.route([healthRoute, homeRoute])

      // Static assets built by webpack into `.public`
      server.route({
        method: 'GET',
        path: `${assetPath}/{param*}`,
        options: {
          cache: {
            expiresIn: config.get('staticCacheTimeout'),
            privacy: 'private'
          },
          handler: {
            directory: {
              path: '.',
              redirectToSlash: true
            }
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/favicon.ico',
        handler(_, h) {
          return h.response().code(StatusCodes.NO_CONTENT).type('image/x-icon')
        }
      })
    }
  }
}

/**
 * @import { Server, ServerRegisterPluginObject } from '@hapi/hapi'
 */
