import { formatDuration } from '~/src/server/common/helpers/duration.js'

describe('formatDuration', () => {
  it.each([
    [60, '1 minute'],
    [1800, '30 minutes'],
    [3600, '1 hour'],
    [7200, '2 hours'],
    [5400, '1 hour and 30 minutes']
  ])('describes %i seconds as "%s"', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected)
  })
})
