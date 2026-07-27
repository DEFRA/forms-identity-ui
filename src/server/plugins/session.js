import yar from '@hapi/yar'

import { config } from '~/src/config/index.js'

const sessionConfig = config.get('session')

/**
 * Yar is used for temporary session data, e.g. UI helpers, session flags.
 * @satisfies {ServerRegisterPluginObject<YarOptions>}
 */
export default {
  plugin: yar,
  options: {
    maxCookieSize: 0, // Always use server-side storage
    cache: {
      cache: sessionConfig.cache.name,
      expiresIn: sessionConfig.cache.ttl
    },
    storeBlank: false,
    cookieOptions: {
      password: sessionConfig.cookie.password,
      isSecure: sessionConfig.cookie.secure,
      ttl: sessionConfig.cookie.ttl
    }
  }
}

/**
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 * @import { YarOptions } from '@hapi/yar'
 */
