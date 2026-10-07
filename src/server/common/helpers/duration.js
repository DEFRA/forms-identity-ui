import { t } from '~/src/server/i18n/index.js'

const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND
const NEAREST_HOUR_TOLERANCE_MINUTES = 5
const NEAREST_HOUR_TOLERANCE_MS =
  NEAREST_HOUR_TOLERANCE_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND

/**
 * Describes a number of seconds the way the pages talk about it — "1 hour",
 * "30 minutes", "1 hour and 30 minutes" — so copy can quote a configured
 * lifetime instead of restating one that may have been changed.
 *
 * The units come from the `duration` translations, where i18next picks a
 * plural form by `count`. English has `_one` and `_other` forms. Welsh keeps
 * the noun singular after a numeral ("2 awr"), so all six of its plural
 * forms would be identical; it has only the unsuffixed key, which i18next
 * uses when the suffixed one is missing. A Welsh `_other` key on its own
 * would not do: counts in the other Welsh categories (0, 1, 2, 3, 6) would
 * fall back to English.
 * @param {number} seconds
 * @param {string} language - the language of the page quoting it
 * @returns {string}
 */
export function formatDuration(seconds, language) {
  const totalMinutes = Math.round(seconds / SECONDS_PER_MINUTE)
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
  const minutes = totalMinutes % MINUTES_PER_HOUR

  if (!hours) {
    return t('duration.minutes', language, { count: minutes })
  }

  if (!minutes) {
    return t('duration.hours', language, { count: hours })
  }

  return t('duration.hoursAndMinutes', language, {
    hours: t('duration.hours', language, { count: hours }),
    minutes: t('duration.minutes', language, { count: minutes })
  })
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
 * @param {string} language - the language of the page quoting it
 * @param {Date} [now]
 * @returns {string}
 */
export function formatHoursUntil(until, language, now = new Date()) {
  const ms = until.getTime() - now.getTime() - NEAREST_HOUR_TOLERANCE_MS
  const hours = Math.max(1, Math.ceil(ms / MS_PER_HOUR))

  return formatDuration(hours * SECONDS_PER_HOUR, language)
}
