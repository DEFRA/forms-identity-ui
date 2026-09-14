import { getLanguage, setLanguage } from '~/src/server/i18n/index.js'

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
    it('gets the language from query if passed as a param', () => {
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
})

/**
 * @import { Request } from '@hapi/hapi'
 */
