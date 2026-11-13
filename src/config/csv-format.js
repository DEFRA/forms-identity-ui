/**
 * Splits a comma-separated value into its trimmed, non-empty entries
 * @param {unknown} value
 * @returns {string[]}
 */
function splitCsv(value) {
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

/**
 * @type {Format}
 */
export const csvFormat = {
  name: 'csv',
  validate(value) {
    if (
      !Array.isArray(value) ||
      !value.length ||
      !value.every((entry) => typeof entry === 'string')
    ) {
      throw new Error('must be a comma-separated list with at least one entry')
    }
  },
  coerce: splitCsv
}

/**
 * Like `csv`, but the list can be empty
 * @type {Format}
 */
export const optionalCsvFormat = {
  name: 'optional-csv',
  validate(value) {
    if (
      !Array.isArray(value) ||
      !value.every((entry) => typeof entry === 'string')
    ) {
      throw new Error('must be a comma-separated list')
    }
  },
  coerce: splitCsv
}

/**
 * @import { Format } from 'convict'
 */
