import crumb from '@hapi/crumb'

import { config } from '~/src/config/index.js'
import { STATIC_PATH_PREFIXES } from '~/src/server/routes/public.js'

const SKIP_PATHS = new Set(['/health', '/favicon.ico'])

/**
 * CSRF protection using `@hapi/crumb`. Health checks and static assets
 * never carry state-changing forms, so they skip the crumb cookie.
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
      !!request &&
      (SKIP_PATHS.has(request.path) ||
        STATIC_PATH_PREFIXES.some((prefix) => request.path.startsWith(prefix)))
  }
}

/**
 * @import { RegisterOptions } from '@hapi/crumb'
 * @import { Request, ServerRegisterPluginObject } from '@hapi/hapi'
 */
