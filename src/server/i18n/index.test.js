import { resolveLanguage } from '~/src/server/i18n/index.js'

describe('i18n', () => {
  describe('resolveLanguage()', () => {
    it('returns the default language', () => {
      const blankRequest = /** @type {Request} */ (/** @type {unknown} */ ({}))
      expect(resolveLanguage(blankRequest.query, blankRequest.yar)).toBe(
        'en-GB'
      )
    })

    it('returns the language set in the session', () => {
      const blankRequest = /** @type {Request} */ (
        /** @type {unknown} */ ({
          yar: {
            get: jest.fn().mockReturnValue('cy')
          }
        })
      )
      expect(resolveLanguage(blankRequest.query, blankRequest.yar)).toBe('cy')
    })

    it('sets the language in the session if passed as a param', () => {
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
      resolveLanguage(blankRequest.query, blankRequest.yar)
      expect(mockYarSet).toHaveBeenCalledWith('language', 'cy')
    })
  })
})

/**
 * @import { Request } from '@hapi/hapi'
 */
