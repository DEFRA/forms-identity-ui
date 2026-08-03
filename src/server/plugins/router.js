import { StatusCodes } from 'http-status-codes'

import {
  healthRoute,
  homeRoute,
  publicRoutes
} from '~/src/server/routes/index.js'
import { interactionRoutes } from '~/src/server/routes/interaction/index.js'

const routes = [...publicRoutes, healthRoute, homeRoute]

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
      server.route(routes)
      server.route(interactionRoutes())

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
