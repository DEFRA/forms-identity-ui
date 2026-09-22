const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND
const NEAREST_HOUR_TOLERANCE_MS = 5 * SECONDS_PER_MINUTE * MS_PER_SECOND

/**
 * @param {number} count
 * @param {string} unit
 */
function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

/**
 * Describes a number of seconds the way the pages talk about it — "1 hour",
 * "30 minutes", "1 hour and 30 minutes" — so copy can quote a configured
 * lifetime instead of restating one that may have been changed.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / SECONDS_PER_MINUTE)
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
  const minutes = totalMinutes % MINUTES_PER_HOUR

  if (!hours) {
    return plural(minutes, 'minute')
  }

  if (!minutes) {
    return plural(hours, 'hour')
  }

  return `${plural(hours, 'hour')} and ${plural(minutes, 'minute')}`
}

/**
 * Describes the time left until a moment in whole hours — "1 hour", "2
 * hours" — so a page can say how long a restriction has left without quoting
 * it to the minute.
 *
 * A time within 5 minutes of a whole hour is rounded to that hour, so "2
 * hours and 3 minutes" reads as "2 hours" rather than "3 hours". Any other
 * time is rounded up. The tolerance also covers a few seconds of clock difference
 * between this service and the one that set the time. It never reads less
 * than 1 hour: a time that has only just passed (or passes while the page is
 * on its way to the browser) should not tell the user to wait for nothing.
 * @param {Date} until
 * @param {Date} [now]
 * @returns {string}
 */
export function formatHoursUntil(until, now = new Date()) {
  const ms = until.getTime() - now.getTime() - NEAREST_HOUR_TOLERANCE_MS
  const hours = Math.max(1, Math.ceil(ms / MS_PER_HOUR))

  return formatDuration(hours * SECONDS_PER_HOUR)
}
