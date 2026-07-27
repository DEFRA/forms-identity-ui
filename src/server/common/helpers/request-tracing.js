import { tracing } from '@defra/hapi-tracing'

import { config } from '~/src/config/index.js'

export const requestTracing = {
  plugin: tracing,
  options: { tracingHeader: config.get('tracing.header') }
}
