const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

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
