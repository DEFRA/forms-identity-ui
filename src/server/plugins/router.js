import { StatusCodes } from 'http-status-codes'

import {
  healthRoute,
  homeRoute,
  interactionRoutes,
  publicRoutes
} from '~/src/server/routes/index.js'
import { assertInteractionRoutesGated } from '~/src/server/routes/interaction.js'

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

      // Refuse to start if any /interaction route is missing the cookie
      // gate — run at onPreStart so routes added by later plugins are
      // covered too
      server.ext('onPreStart', assertInteractionRoutesGated)
    }
  }
}

/**
 * @import { Server, ServerRegisterPluginObject } from '@hapi/hapi'
 */
