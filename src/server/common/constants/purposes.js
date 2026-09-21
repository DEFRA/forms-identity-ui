/**
 * OTP purposes. A purpose names the full authority a code grants in
 * JOURNEY_CHALLENGE form, so it captures both the journey and the challenge
 * together (see the spec's purpose naming rule). Codes are isolated per
 * {uid, purpose}, so each new challenge gets its own entry.
 * @type {{ SIGNIN_VERIFY_EMAIL: 'SIGNIN_VERIFY_EMAIL', ACCOUNT_VERIFY_PHONE: 'ACCOUNT_VERIFY_PHONE', ACCOUNT_VERIFY_EMAIL: 'ACCOUNT_VERIFY_EMAIL' }}
 */
export const PURPOSE = {
  SIGNIN_VERIFY_EMAIL: 'SIGNIN_VERIFY_EMAIL',
  ACCOUNT_VERIFY_PHONE: 'ACCOUNT_VERIFY_PHONE',
  ACCOUNT_VERIFY_EMAIL: 'ACCOUNT_VERIFY_EMAIL'
}

/**
 * @typedef { typeof PURPOSE[keyof typeof PURPOSE] } PurposeType
 */
