import crumb from '@hapi/crumb'

import { config } from '~/src/config/index.js'

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
    }
  }
}

/**
 * @import { RegisterOptions } from '@hapi/crumb'
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 */
