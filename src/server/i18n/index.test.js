import {
  getLanguage,
  languageFromUiLocales,
  overrideLanguageFromUiLocales,
  setLanguage
} from '~/src/server/i18n/index.js'

describe('i18n', () => {
  describe('getLanguage()', () => {
    it('returns the default language', () => {
      const blankRequest = /** @type {Request} */ (/** @type {unknown} */ ({}))
      expect(getLanguage(blankRequest.query, blankRequest.yar)).toBe('en-GB')
    })

    it('returns the language set in the session', () => {
      const blankRequest = /** @type {Request} */ (
        /** @type {unknown} */ ({
          yar: {
            id: '123',
            get: jest.fn().mockReturnValue('cy')
          }
        })
      )
      expect(getLanguage(blankRequest.query, blankRequest.yar)).toBe('cy')
    })

    it('gets the language from query if passed as a param', () => {
      const blankRequest = /** @type {Request} */ (
        /** @type {unknown} */ ({
          query: {
            language: 'cy'
          }
        })
      )
      const language = getLanguage(blankRequest.query, blankRequest.yar)
      expect(language).toBe('cy')
    })
  })
  describe('setLanguage()', () => {
    it('sets the language from query if passed as a param', () => {
      const mockYarSet = jest.fn()
      const blankRequest = /** @type {Request} */ (
        /** @type {unknown} */ ({
          yar: {
            get: jest.fn(),
            set: mockYarSet
          },
          query: {
            language: 'cy'
          }
        })
      )

      setLanguage(blankRequest)
      expect(mockYarSet).toHaveBeenCalledWith('language', 'cy')
    })
  })

  describe('languageFromUiLocales()', () => {
    it.each([
      ['cy', 'cy'],
      ['en-GB', 'en-GB'],
      ['  cy  ', 'cy']
    ])('reads %p as %p', (uiLocales, expected) => {
      expect(languageFromUiLocales(uiLocales)).toBe(expected)
    })

    it.each([[undefined], [''], ['fr de'], [42]])(
      'finds no language in %p',
      (uiLocales) => {
        expect(languageFromUiLocales(uiLocales)).toBeUndefined()
      }
    )
  })

  describe('overrideLanguageFromUiLocales()', () => {
    /**
     * @param {Record<string, unknown>} session
     * @param {Record<string, unknown>} [query]
     */
    function requestWith(session, query = {}) {
      return /** @type {Request} */ (
        /** @type {unknown} */ ({
          query,
          yar: {
            get: (/** @type {string} */ key) => session[key],
            set: (/** @type {string} */ key, /** @type {unknown} */ value) => {
              session[key] = value
            }
          }
        })
      )
    }

    it('sets the session language from ui_locales', () => {
      const session = /** @type {Record<string, unknown>} */ ({})

      overrideLanguageFromUiLocales(requestWith(session), {
        uid: 'uid-1',
        params: { ui_locales: 'cy' }
      })

      expect(session).toEqual({
        language: 'cy',
        overrideLanguageFromUiLocales: 'uid-1'
      })
    })

    it('keeps the language the user chose later in the same interaction', () => {
      const session = {
        language: 'en-GB',
        overrideLanguageFromUiLocales: 'uid-1'
      }

      overrideLanguageFromUiLocales(requestWith(session), {
        uid: 'uid-1',
        params: { ui_locales: 'cy' }
      })

      expect(session.language).toBe('en-GB')
    })

    it('applies ui_locales again for a new interaction', () => {
      const session = {
        language: 'en-GB',
        overrideLanguageFromUiLocales: 'uid-1'
      }

      overrideLanguageFromUiLocales(requestWith(session), {
        uid: 'uid-2',
        params: { ui_locales: 'cy' }
      })

      expect(session.language).toBe('cy')
    })

    it('lets a language query on the same request win', () => {
      const session = { language: 'en-GB' }

      overrideLanguageFromUiLocales(
        requestWith(session, { language: 'en-GB' }),
        {
          uid: 'uid-1',
          params: { ui_locales: 'cy' }
        }
      )

      expect(session.language).toBe('en-GB')
    })

    it('leaves the session language alone when ui_locales has no supported language', () => {
      const session = { language: 'cy' }

      overrideLanguageFromUiLocales(requestWith(session), {
        uid: 'uid-1',
        params: { ui_locales: 'fr' }
      })

      expect(session.language).toBe('cy')
    })
  })
})

/**
 * @import { Request } from '@hapi/hapi'
 */
