import { applyUrlParam } from '~/src/server/plugins/nunjucks/environment.js'

describe('applyUrlParam', () => {
  test('should return blank string if not a string input', () => {
    // @ts-expect-error - wrong datatype for test
    expect(applyUrlParam({}, 'name', 'val')).toBe('')
  })

  test('should add param', () => {
    expect(applyUrlParam('/my-path/my-form', 'language', 'cy')).toBe(
      '/my-path/my-form?language=cy'
    )
  })

  test('should concat param', () => {
    expect(
      applyUrlParam('/my-path/my-form?otherParam=123', 'language', 'en-GB')
    ).toBe('/my-path/my-form?otherParam=123&language=en-GB')
  })

  test('should replace param', () => {
    expect(
      applyUrlParam('/my-path/my-form?language=cy', 'language', 'en-GB')
    ).toBe('/my-path/my-form?language=en-GB')
  })
})
