import { Engine as CatboxMemory } from '@hapi/catbox-memory'
import { Engine as CatboxRedis } from '@hapi/catbox-redis'

import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { buildRedisClient } from '~/src/server/common/helpers/redis-client.js'

/**
 * Provide the session cache engine
 * @param {'redis' | 'memory'} engine - the backing cache engine
 * @returns {CatboxRedis<unknown> | CatboxMemory<unknown>}
 */
export function getCacheEngine(engine) {
  if (engine === 'redis') {
    logger.info('Using Redis session cache')
    return new CatboxRedis({ client: buildRedisClient() })
  }

  if (config.get('isProduction')) {
    logger.error(
      'Catbox Memory is for local development only, it should not be used in production!'
    )
  }

  logger.info('Using Catbox Memory session cache')
  return new CatboxMemory()
}
