import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { createServer } from '~/src/server/index.js'

process.on('unhandledRejection', (err) => {
  logger.info('Unhandled rejection')
  logger.error(
    err,
    `[unhandledRejection] Unhandled promise rejection: ${err instanceof Error ? err.message : String(err)}`
  )
  throw err
})

/**
 * Main entrypoint to the application.
 */
async function startServer() {
  const server = await createServer()
  await server.start()

  process.send?.('online')

  server.logger.info('Server started successfully')
  server.logger.info(
    `Access your frontend on http://localhost:${config.get('port')}`
  )
}

startServer().catch((/** @type {unknown} */ error) => {
  logger.info('Server failed to start :(')
  logger.error(
    `[serverStartup] Server failed to start: ${error instanceof Error ? error.message : String(error)}`
  )
  throw error
})
