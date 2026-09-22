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
  coerce(value) {
    return String(value)
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
}

/**
 * @import { Format } from 'convict'
 */
