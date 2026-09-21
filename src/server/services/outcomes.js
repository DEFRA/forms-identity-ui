/**
 * Outcomes named once, so a typo cannot silently change a journey. Exported
 * because the route handlers branch on the same names, and the API returns
 * these same verdicts as its `status`.
 */
export const INVALID_EMAIL = 'invalid-email'
export const CODE_SENT = 'code-sent'
export const INVALID_CODE = 'invalid-code'
export const INVALID_CODE_FORMAT = 'invalid-code-format'
export const INVALID_CODE_CONSUMED_OR_EXPIRED =
  'invalid-code-consumed-or-expired'
export const PHONE_REQUIRED = 'phone-required'
export const INVALID_PHONE = 'invalid-phone'
export const VALID = 'valid'
export const SIGNED_IN = 'signed-in'
export const RESTART = 'restart'

/**
 * Journey outcomes: plain data the route handlers translate into
 * responses (views, redirects, or completing the OIDC interaction)
 * @typedef {{ outcome: 'invalid-email', email: string, errorKey: string }
 *   | { outcome: 'code-sent', email: string }} EmailOutcome
 * @typedef {{ outcome: 'invalid-code', errorKey: string }
 *   | { outcome: 'invalid-code-consumed-or-expired' }
 *   | { outcome: 'signed-in', accountId: string }
 *   | { outcome: 'valid' }
 *   | { outcome: 'phone-required' }} CodeOutcome
 * @typedef {{ outcome: 'invalid-phone', phone: string, errorKey: string }
 *   | { outcome: 'signed-in', accountId: string }
 *   | { outcome: 'restart' }} PhoneOutcome
 */
