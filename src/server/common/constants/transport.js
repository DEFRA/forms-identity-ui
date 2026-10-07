/**
 * OTP requests can be sent over any of these transport types.
 * @type {{ EMAIL: 'EMAIL', SMS: 'SMS' }}
 */
export const TRANSPORT = {
  EMAIL: 'EMAIL',
  SMS: 'SMS'
}

/**
 * @typedef {typeof TRANSPORT[keyof typeof TRANSPORT]} TransportType
 */
