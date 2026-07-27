import pulse from 'hapi-pulse'

/**
 * Graceful shutdown on SIGINT/SIGTERM
 * @satisfies {ServerRegisterPluginObject<{ timeout: number }>}
 */
export default {
  plugin: pulse,
  options: {
    timeout: 800
  }
}

/**
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 */
