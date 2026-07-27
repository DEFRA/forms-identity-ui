import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'

const assetPath = config.get('assetPath')

/** @type {Record<string, string> | undefined} */
let webpackManifest

/**
 * Nunjucks view context
 * @param {Request | null} request
 */
export function context(request) {
  const manifestPath = join(config.get('publicDir'), 'assets-manifest.json')

  if (!webpackManifest) {
    try {
      webpackManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch {
      logger.info(
        `[webpackManifestMissing] Webpack ${basename(manifestPath)} not found - running without asset manifest`
      )
    }
  }

  return {
    assetPath: `${assetPath}/assets`,
    serviceName: 'Sign in to Defra Forms',
    cspNonce: request?.plugins.blankie?.nonces?.script,

    /**
     * @param {string} asset - webpack asset name
     */
    getAssetPath(asset = '') {
      return `${assetPath}/${webpackManifest?.[asset] ?? asset}`
    }
  }
}

/**
 * @import { Request } from '@hapi/hapi'
 */
