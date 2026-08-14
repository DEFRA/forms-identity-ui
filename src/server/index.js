import http from 'node:http'
import https from 'node:https'

import hapi from '@hapi/hapi'
import inert from '@hapi/inert'
import Scooter from '@hapi/scooter'
import Wreck from '@hapi/wreck'
import blipp from 'blipp'

import { config } from '~/src/config/index.js'
import { requestLogger } from '~/src/server/common/helpers/logging/request-logger.js'
import { requestTracing } from '~/src/server/common/helpers/request-tracing.js'
import { prepareSecureContext } from '~/src/server/common/helpers/secure-context/index.js'
import { getCacheEngine } from '~/src/server/common/helpers/session-cache/cache-engine.js'
import pluginBlankie from '~/src/server/plugins/blankie.js'
import pluginCrumb from '~/src/server/plugins/crumb.js'
import pluginErrorPages from '~/src/server/plugins/error-pages.js'
import { plugin as pluginViews } from '~/src/server/plugins/nunjucks/index.js'
import pluginOidc from '~/src/server/plugins/oidc.js'
import pluginPulse from '~/src/server/plugins/pulse.js'
import pluginRouter from '~/src/server/plugins/router.js'
import pluginSession from '~/src/server/plugins/session.js'

if (config.get('httpProxy')) {
  Wreck.agents = {
    http: http.globalAgent,
    https: https.globalAgent,
    httpsAllowUnauthorized: https.globalAgent
  }
}

/**
 * @returns {ServerOptions}
 */
function serverOptions() {
  return {
    host: config.get('host'),
    port: config.get('port'),
    router: {
      stripTrailingSlash: true
    },
    routes: {
      validate: {
        options: {
          abortEarly: false
        }
      },
      security: {
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: false
        },
        xss: 'enabled',
        noSniff: true,
        xframe: true
      },
      files: {
        relativeTo: config.get('publicDir')
      }
    },
    cache: [
      {
        name: config.get('session.cache.name'),
        engine: getCacheEngine(config.get('session.cache.engine'))
      }
    ]
  }
}

export async function createServer() {
  const server = hapi.server(serverOptions())

  await server.register(requestLogger)
  await server.register(requestTracing)

  if (config.get('isSecureContextEnabled')) {
    prepareSecureContext(server)
  }

  await server.register(pluginPulse)
  await server.register(pluginSession)
  await server.register(pluginCrumb)
  await server.register(inert)
  await server.register(Scooter)
  await server.register(pluginBlankie)
  await server.register(pluginViews)
  await server.register(pluginOidc)
  await server.register(pluginRouter)
  await server.register(pluginErrorPages)

  if (config.get('isDevelopment')) {
    await server.register(blipp)
  }

  return server
}

/**
 * @import { ServerOptions } from '@hapi/hapi'
 */
