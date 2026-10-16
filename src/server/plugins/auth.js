import {
  CITIZEN_SESSION,
  citizenSessionScheme
} from '~/src/server/plugins/scheme.js'

export default /** @satisfies {ServerRegisterPluginObject<void>} */ ({
  plugin: {
    name: 'auth',
    register(server) {
      server.auth.scheme(CITIZEN_SESSION, citizenSessionScheme)
      server.auth.strategy(CITIZEN_SESSION, CITIZEN_SESSION)

      // Applies to every route, including the ones the engine plugin
      // registers, because hapi rebuilds routes already in the table. `try`
      // means an anonymous request carries on with no credentials, so no
      // existing route changes behaviour.
      server.auth.default({ strategy: CITIZEN_SESSION, mode: 'try' })
    }
  }
})

/**
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 */
