import {
  formatDuration,
  formatHoursUntil
} from '~/src/server/common/helpers/duration.js'

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

describe('formatHoursUntil', () => {
  const NOW = new Date('2026-09-21T10:00:00.000Z')

  /**
   * @param {number} seconds - from NOW
   */
  function secondsFromNow(seconds) {
    return new Date(NOW.getTime() + seconds * 1000)
  }

  it.each([
    [7200, '2 hours'],
    [7199, '2 hours'],
    [6900, '2 hours'],
    [5400, '2 hours'],
    [3660, '1 hour'],
    [3900, '1 hour'],
    [3901, '2 hours'],
    [3600, '1 hour'],
    [600, '1 hour'],
    [7500, '2 hours'],
    [7560, '3 hours'],
    [10800, '3 hours']
  ])('describes %i seconds away as "%s"', (seconds, expected) => {
    expect(formatHoursUntil(secondsFromNow(seconds), NOW)).toBe(expected)
  })

  it('does not round up an exact hour for a few seconds of clock difference', () => {
    expect(formatHoursUntil(secondsFromNow(7205), NOW)).toBe('2 hours')
  })

  it.each([0, -60])(
    'describes a time %i seconds away as 1 hour rather than none',
    (seconds) => {
      expect(formatHoursUntil(secondsFromNow(seconds), NOW)).toBe('1 hour')
    }
  )
})
