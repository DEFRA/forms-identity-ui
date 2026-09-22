/**
 * @param {string} value
 * @returns {string[]}
 */
export function splitCsv(value) {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}
