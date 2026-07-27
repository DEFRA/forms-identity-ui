import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import nunjucks from 'nunjucks'

import { config } from '~/src/config/index.js'

const nodeRequire = createRequire(import.meta.url)

const govukFrontendPath = dirname(
  nodeRequire.resolve('govuk-frontend/package.json')
)

export const paths = [join(config.get('appDir'), 'views')]

export const environment = nunjucks.configure(
  [...paths, join(govukFrontendPath, 'dist')],
  {
    trimBlocks: true,
    lstripBlocks: true,
    watch: config.get('isDevelopment'),
    noCache: config.get('isDevelopment')
  }
)

environment.addGlobal('govukRebrand', true)
