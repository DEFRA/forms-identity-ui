import crumb from '@hapi/crumb'

import { config } from '~/src/config/index.js'

const assetPath = config.get('assetPath')

/**
 * CSRF protection using `@hapi/crumb`
 * @satisfies {ServerRegisterPluginObject<RegisterOptions>}
 */
export default {
  plugin: crumb,
  options: {
    logUnauthorized: true,
    cookieOptions: {
      isSecure: config.get('isProduction')
    },
    /**
     * @param {Request} [request]
     */
    skip: (request) =>
      request?.path === '/health' || !!request?.path.startsWith(`${assetPath}/`)
  }
}

/**
 * @import { RegisterOptions } from '@hapi/crumb'
 * @import { Request, ServerRegisterPluginObject } from '@hapi/hapi'
 */
