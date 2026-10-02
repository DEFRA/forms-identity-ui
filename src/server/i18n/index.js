import i18next from 'i18next'

import { logger } from '~/src/server/common/helpers/logging/logger.js'
import cy from '~/src/server/i18n/translations/cy.json' with { type: 'json' }
import enGB from '~/src/server/i18n/translations/en-GB.json' with { type: 'json' }

export const i18n = i18next.createInstance()

i18n
  .init({
    resources: {
      'en-GB': { translation: enGB },
      cy: { translation: cy }
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
 * Get the request language
 * @param { RequestQuery | undefined } query - the request query parameters
 * @param {Yar} [yar]
 * @returns {string}
 */
export function getLanguage(query, yar) {
  const defaultLang = 'en-GB'
  query ??= {}

  return (
    (yar?.id && yar.get('language')) ??
    ('language' in query ? /** @type {string} */ (query.language) : defaultLang)
  )
}

/**
 * Set the language in the session if the query has a `language` key
 * @param {Request<ReqRefDefaults>} request
 */
export function setLanguage(request) {
  const { yar, query } = request

  if ('language' in query) {
    yar.set('language', query.language)
  }
}

/**
 * @import { Request, RequestQuery, ReqRefDefaults } from '@hapi/hapi'
 * @import { Yar } from '@hapi/yar'
 */
