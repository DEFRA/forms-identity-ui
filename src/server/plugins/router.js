import { StatusCodes } from 'http-status-codes'

import {
  healthRoute,
  homeRoute,
  interactionRoutes,
  publicRoutes
} from '~/src/server/routes/index.js'

const routes = [...publicRoutes, healthRoute, homeRoute, ...interactionRoutes]

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
