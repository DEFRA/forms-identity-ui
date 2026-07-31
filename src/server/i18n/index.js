import i18next from 'i18next'

import { logger } from '~/src/server/common/helpers/logging/logger.js'
import enGB from '~/src/server/i18n/translations/en-GB.json' with { type: 'json' }

export const i18n = i18next.createInstance()

i18n
  .init({
    resources: {
      'en-GB': { translation: enGB }
    },
    fallbackLng: 'en-GB',
    interpolation: {
      prefix: '[[',
      suffix: ']]',
      escapeValue: false
    }
  })
  .catch((err) => {
    // init with inline resources completes synchronously — unreachable
    logger.error(err, 'Fatal init for translator instance')
  })

/**
 * Translate a key for the given language
 * @param {string} key
 * @param {string} lang
 * @param {Record<string, unknown>} [opts]
 * @returns {string}
 */
export function t(key, lang, opts) {
  return i18n.t(key, { lng: lang, ...opts })
}

/**
 * Resolve the request language, persisting a `?language=` override in the session
 * @param {RequestQuery} [query]
 * @param {Yar | null} [yar]
 * @returns {string}
 */
export function resolveLanguage(query, yar) {
  const defaultLang = 'en-GB'

  query ??= {}

  try {
    if (yar && 'language' in query) {
      yar.set('language', query.language)
    }

    return yar?.get('language') ?? defaultLang
  } catch {
    // yar has no store on unmatched routes (404) and throws on access
    return defaultLang
  }
}

/**
 * @import { RequestQuery } from '@hapi/hapi'
 * @import { Yar } from '@hapi/yar'
 */
