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

/**
 * Nunjucks filter to add/replace a parameter on a query string of a url.
 * Currently only used in forms-runner.
 * @param {string} urlPath - existing relative url with query string
 * @param {string} paramName - name of parameter
 * @param {string} paramValue - value of parameter
 * @returns {string}
 */
export function applyUrlParam(urlPath, paramName, paramValue) {
  if (typeof urlPath !== 'string') {
    return ''
  }
  const url = new URL(urlPath, 'https://dummy')
  url.searchParams.set(paramName, paramValue)

  return url.pathname + url.search
}
environment.addFilter('applyUrlParam', applyUrlParam)
