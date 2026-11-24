import i18next from 'i18next'

import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { CY, EN_GB } from '~/src/server/constants.js'
import cy from '~/src/server/i18n/translations/cy.json' with { type: 'json' }
import enGB from '~/src/server/i18n/translations/en-GB.json' with { type: 'json' }

export const i18n = i18next.createInstance()

i18n
  .init({
    resources: {
      'en-GB': { translation: enGB },
      cy: { translation: cy }
    },
    fallbackLng: EN_GB,
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
  const defaultLang = EN_GB
  query ??= {}

  return (
    (yar?.id && yar.get('language')) ??
    ('language' in query ? /** @type {string} */ (query.language) : defaultLang)
  )
}

/**
 * Set the language in the session if the query has a `language` key
 * @param {Pick<Request, 'query' | 'yar'>} request
 */
export function setLanguage(request) {
  const { yar, query } = request

  if ('language' in query) {
    yar.set('language', query.language)
  }
}

/**
 * The supported language in an OIDC `ui_locales` value
 * @param {unknown} uiLocales
 * @returns {string | undefined} undefined when no tag is supported
 */
export function languageFromUiLocales(uiLocales) {
  if (typeof uiLocales !== 'string') {
    return undefined
  }

  if (uiLocales.trim() === EN_GB) {
    return EN_GB
  }
  if (uiLocales.trim() === CY) {
    return CY
  }
  return undefined
}

/** The session key naming the interaction whose `ui_locales` was applied */
const OVERRIDE_LANGUAGE_FROM_UI_LOCALES = 'overrideLanguageFromUiLocales'

/**
 * Sets the session language from the client's `ui_locales`, once per
 * interaction. Applying it only once means a user who then switches language
 * on a page keeps their choice for the rest of the sign in. A `language`
 * query on the same request will override the client's `ui_locales` so allows
 * the user to explicitly switch during sign-in.
 * @param {Pick<Request, 'query' | 'yar'>} request
 * @param {{ uid: string, params: Record<string, unknown> }} details
 */
export function overrideLanguageFromUiLocales(request, details) {
  const { yar, query } = request

  if (yar.get(OVERRIDE_LANGUAGE_FROM_UI_LOCALES) === details.uid) {
    return
  }

  yar.set(OVERRIDE_LANGUAGE_FROM_UI_LOCALES, details.uid)

  const language = languageFromUiLocales(details.params.ui_locales)

  if (language && !('language' in query)) {
    yar.set('language', language)
  }
}

/**
 * @import { Request, RequestQuery } from '@hapi/hapi'
 * @import { Yar } from '@hapi/yar'
 */
