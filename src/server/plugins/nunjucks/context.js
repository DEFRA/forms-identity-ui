import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import Boom from '@hapi/boom'
import { StatusCodes } from 'http-status-codes'

import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { getLanguage, t } from '~/src/server/i18n/index.js'

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

  const { response } = request ?? {}
  const isResponseOK =
    !Boom.isBoom(response) && response?.statusCode === StatusCodes.OK

  const language = getLanguage(request?.query, request?.yar)
  const availableLanguages = [
    { code: 'en-GB', name: 'English' },
    { code: 'cy', name: 'Cymraeg' }
  ]

  return {
    assetPath: '/assets',
    language,
    availableLanguages,
    serviceName: t('service.name', language),
    cspNonce: request?.plugins.blankie?.nonces?.script,
    currentPath: request ? `${request.path}${request.url.search}` : undefined,

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
    },
    isResponseOK
  }
}

/**
 * @import { Request } from '@hapi/hapi'
 */
