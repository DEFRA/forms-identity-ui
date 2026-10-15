/**
 * OTP requests can be sent over any of these transport types.
 * @type {{ EMAIL: 'email', SMS: 'sms' }}
 */
export const TRANSPORT = {
  EMAIL: 'email',
  SMS: 'sms'
}

/**
 * @typedef {typeof TRANSPORT[keyof typeof TRANSPORT]} TransportType
 */
