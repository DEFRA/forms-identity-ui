import { createHash } from 'node:crypto'

/**
 * Digests an identifier so it can travel to forms-identity-api as a URL path
 * segment, keeping the identifier itself out of the request line that load
 * balancers, nginx, the application logger and tracing all record.
 *
 * SHA-256 with base64url output: deterministic, so the digest is a usable
 * storage key, and alphabet-safe, so a digest can never contain `/` or `.`.
 * Unsalted because the lookup has to resolve without a stored salt, and the
 * inputs are 256-bit random values (`nanoid(43)` jtis, provider uids), so
 * there is no input space to enumerate.
 * @param {string} id
 * @returns {string}
 */
export function hashId(id) {
  return createHash('sha256').update(id).digest('base64url')
}
