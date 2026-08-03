import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { resolveLanguage, t } from '~/src/server/i18n/index.js'

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

  const language = resolveLanguage(request?.query, request?.yar)

  return {
    assetPath: '/assets',
    serviceName: t('service.name', language),
    cspNonce: request?.plugins.blankie?.nonces?.script,

    /**
     * @param {string} key
     * @param {Record<string, unknown>} [opts]
     */
    t: (key, opts) => t(key, language, opts),

    /**
     * @param {string} asset - webpack asset name
     */
    getAssetPath(asset = '') {
      return `/${webpackManifest?.[asset] ?? asset}`
    }
  }
}

/**
 * @import { Request } from '@hapi/hapi'
 */
